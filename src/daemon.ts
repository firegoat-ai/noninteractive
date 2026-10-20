import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type { OutputMode } from "./client";
import {
	ensureSessionsDir,
	sessionBinDir,
	sessionDir,
	sessionOutputFile,
	sessionUrlsFile,
	socketPath,
} from "./paths";
import { Screen } from "./screen";
import { announcesSelfOpen, extractUrls } from "./urls";

interface DaemonMessage {
	action: "read" | "send" | "sendread" | "stop" | "status";
	data?: string;
	wait?: boolean;
	timeout?: number;
	mode?: OutputMode;
}

const OUTPUT_MODES: readonly OutputMode[] = ["new", "screen", "all"];
const SELF_OPEN_WINDOW_MAX = 4000;

// map node's process.arch to Go's GOARCH, which is what the shipped binaries are
// named with. node reports "x64" for 64-bit intel/amd; Go calls it "amd64", so
// the two only agree on arm64 — without this map a linux-x64 host (e.g. the eval
// sandbox) looks for ptybridge-linux-x64 and never finds ptybridge-linux-amd64.
const GOARCH_BY_NODE_ARCH: Record<string, string> = {
	x64: "amd64",
	arm64: "arm64",
};

// the shipped binary name for a given node platform/arch. exported so a test can
// assert every native/ file is reachable from the host that needs it.
export function ptyBridgeBinaryName(
	nodePlatform: string,
	nodeArch: string,
): string {
	const arch = GOARCH_BY_NODE_ARCH[nodeArch] ?? nodeArch;
	return `ptybridge-${nodePlatform}-${arch}`;
}

function getPtyBridge(): string {
	const binaryName = ptyBridgeBinaryName(process.platform, process.arch);

	const scriptDir = dirname(process.argv[1] || process.execPath);
	const candidates = [
		resolve(scriptDir, "..", "native", binaryName),
		resolve(scriptDir, "native", binaryName),
		resolve(dirname(import.meta.dirname), "native", binaryName),
		resolve(import.meta.dirname, "..", "native", binaryName),
	];
	for (const p of candidates) {
		try {
			const { statSync } = require("node:fs");
			if (statSync(p).isFile()) return p;
		} catch {}
	}
	// fail loudly with the exact miss — returning a non-existent path here only
	// yields a bare ENOENT from spawn, which is why the arch mismatch was so hard
	// to diagnose (see #10).
	throw new Error(
		`ptybridge binary not found: looked for "${binaryName}" ` +
			`(node ${process.platform}/${process.arch}) in:\n  ${candidates.join("\n  ")}`,
	);
}

function createInterceptorScripts(name: string) {
	const binDir = sessionBinDir(name);
	const urlsFile = sessionUrlsFile(name);
	mkdirSync(binDir, { recursive: true });

	// macOS: shadow `open` — only intercept http/https URLs, pass everything else through
	const openScript = `#!/bin/sh
case "$1" in
  http://*|https://*) echo "$1" >> "${urlsFile}" ;;
  *) /usr/bin/open "$@" ;;
esac
`;

	// linux: shadow xdg-open
	const xdgOpenScript = `#!/bin/sh
echo "$1" >> "${urlsFile}"
`;

	// BROWSER env var target
	const browserOpenScript = `#!/bin/sh
echo "$1" >> "${urlsFile}"
`;

	for (const [file, content] of [
		["open", openScript],
		["xdg-open", xdgOpenScript],
		["browser-open", browserOpenScript],
	] as const) {
		const path = resolve(binDir, file);
		writeFileSync(path, content);
		chmodSync(path, 0o755);
	}
}

function cleanupSession(name: string) {
	try {
		rmSync(sessionDir(name), { recursive: true, force: true });
	} catch {}
}

export function runDaemon(
	sessionName: string,
	executable: string,
	args: string[],
) {
	ensureSessionsDir();
	const sock = socketPath(sessionName);

	try {
		unlinkSync(sock);
	} catch {}

	createInterceptorScripts(sessionName);

	const screen = new Screen();
	const stderrDecoder = new TextDecoder();
	let bytesReceived = 0;
	let processExited = false;
	let exitCode: number | null = null;
	let lastReadBytes = 0; // what the client has seen, for --wait
	// rendered output handed out since urls were last reported: a "opening your
	// browser" announcement may arrive a read before the url it belongs to.
	let selfOpenWindow = "";
	// every url surfaced to the client (output scans + browser-open intercepts),
	// punctuation-trimmed and deduped; the client decides what to do with them
	const detectedUrls = new Set<string>();
	const reportedUrls = new Set<string>();
	// urls the shim actually intercepted (the CLI tried to open them via
	// PATH `open`/`xdg-open`/$BROWSER, which we captured and suppressed). these
	// are the ones the client MUST open itself — a CLI that self-opens natively
	// (railway/supabase) bypasses the shim and never lands here, so the client
	// knows not to double-open it.
	const interceptedUrls = new Set<string>();
	// intercepted urls already flagged to the client. tracked separately from
	// reportedUrls because a url can be surfaced from stdout (reported) before
	// the shim's file write lands — we must still send the intercept signal
	// afterwards, even though the url itself is no longer "new".
	const reportedIntercepted = new Set<string>();

	type Waiter = {
		resolve: () => void;
		timer: ReturnType<typeof setTimeout>;
	};
	const waiters: Waiter[] = [];

	let notifyDebounce: ReturnType<typeof setTimeout> | null = null;
	const NOTIFY_SETTLE_MS = 50;

	// anti-cascade: track last stdin write so rapid chained sends
	// don't land keystrokes before the PTY settles from the previous interaction
	let lastStdinWrite = 0;
	const INPUT_SETTLE_MS = 150;

	function notifyWaiters() {
		if (waiters.length === 0) return;
		// debounce: wait a short time for more output to arrive before resolving
		// this prevents resolving on partial output (e.g. PTY echo before the real response)
		if (notifyDebounce) clearTimeout(notifyDebounce);
		notifyDebounce = setTimeout(() => {
			notifyDebounce = null;
			let w = waiters.shift();
			while (w) {
				clearTimeout(w.timer);
				w.resolve();
				w = waiters.shift();
			}
		}, NOTIFY_SETTLE_MS);
	}

	const binDir = sessionBinDir(sessionName);
	let ptyBridge: string;
	try {
		ptyBridge = getPtyBridge();
	} catch (err) {
		// persist the descriptive error so a follow-up `read`/`send` surfaces it
		// (the daemon exits before the socket is up, so `start` will report a
		// failed start; the file fallback carries the real reason).
		const msg = `[error: ${(err as Error).message}]`;
		try {
			writeFileSync(sessionOutputFile(sessionName), msg);
		} catch {}
		process.stderr.write(`${msg}\n`);
		process.exit(1);
	}
	const spawnCwd = process.env.NI_CWD || process.cwd();
	const proc = spawn(ptyBridge, [executable, ...args], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: spawnCwd,
		env: {
			...process.env,
			TERM: "xterm-256color",
			BROWSER: resolve(binDir, "browser-open"),
			PATH: `${binDir}:${process.env.PATH}`,
		},
	});

	const { stdout, stderr, stdin } = proc;

	function scanForUrls(text: string) {
		for (const url of extractUrls(text)) detectedUrls.add(url);
	}

	function readInterceptedUrls() {
		const urlsFile = sessionUrlsFile(sessionName);
		try {
			if (!existsSync(urlsFile)) return;
			const content = readFileSync(urlsFile, "utf-8");
			const lines = content.split("\n");
			for (const line of lines) {
				// intercepted urls are the exact argv the child asked to open, not
				// prose — keep them verbatim (a trailing "." etc may be a real
				// query/state value). trimming only applies to scanned output.
				const trimmed = line.trim();
				if (!trimmed) continue;
				detectedUrls.add(trimmed);
				interceptedUrls.add(trimmed);
			}
		} catch {}
	}

	function onOutput(bytes: Buffer | string) {
		bytesReceived += bytes.length;
		void screen.write(bytes);
		scanForUrls(typeof bytes === "string" ? bytes : bytes.toString());
		notifyWaiters();
	}

	// stdout carries the whole pty (raw bytes, so xterm decodes utf-8 split across
	// chunks); stderr is only ptybridge's own messages, decoded separately so the
	// two streams can't interleave inside a multi-byte sequence.
	stdout?.on("data", (chunk: Buffer) => onOutput(chunk));
	stderr?.on("data", (chunk: Buffer) =>
		onOutput(stderrDecoder.decode(chunk, { stream: true })),
	);

	// persist rendered output so reads work after the daemon shuts down
	async function persistOutput() {
		await screen.flush();
		const footer = processExited ? `\n[exited ${exitCode}]` : "";
		try {
			writeFileSync(sessionOutputFile(sessionName), `${screen.all()}${footer}`);
		} catch {}
	}

	// "close" (not "exit"): stdio is fully drained, so no output lands after it
	proc.on("close", async (code) => {
		processExited = true;
		exitCode = code;
		await persistOutput();
		// flush immediately on exit — no need to debounce
		if (notifyDebounce) clearTimeout(notifyDebounce);
		notifyDebounce = null;
		let w = waiters.shift();
		while (w) {
			clearTimeout(w.timer);
			w.resolve();
			w = waiters.shift();
		}

		setTimeout(() => {
			server.close();
			try {
				unlinkSync(sock);
			} catch {}
			cleanupSession(sessionName);
			process.exit(0);
		}, 60_000);
	});

	proc.on("error", (err) => {
		void screen.write(`\r\n[error: ${err.message}]\r\n`);
		processExited = true;
	});

	const server = createServer((socket) => {
		let buf = "";

		socket.on("data", (chunk) => {
			buf += chunk.toString();
			try {
				const msg = JSON.parse(buf);
				buf = "";
				handle(msg, socket);
			} catch {}
		});
	});

	function render(mode: OutputMode): string {
		// always advance the "new" cursor: whatever the client was shown counts as seen
		const fresh = screen.takeNew();
		selfOpenWindow = `${selfOpenWindow}${fresh}\n`.slice(-SELF_OPEN_WINDOW_MAX);
		if (mode === "screen") return screen.screen();
		if (mode === "all") return screen.all();
		return fresh;
	}

	async function respondWithOutput(socket: Socket, mode: OutputMode) {
		lastReadBytes = bytesReceived;
		await screen.flush();
		const output = render(mode);
		readInterceptedUrls();
		const newUrls = Array.from(detectedUrls).filter(
			(u) => !reportedUrls.has(u),
		);
		for (const u of newUrls) reportedUrls.add(u);
		// report each intercepted url once, independently of newUrls — the
		// intercept signal can arrive after the url was already surfaced.
		const intercepted = Array.from(interceptedUrls).filter(
			(u) => !reportedIntercepted.has(u),
		);
		for (const u of intercepted) reportedIntercepted.add(u);
		const reportsUrls = newUrls.length > 0 || intercepted.length > 0;
		const selfOpen = reportsUrls && announcesSelfOpen(selfOpenWindow);
		if (reportsUrls) selfOpenWindow = "";
		socket.end(
			JSON.stringify({
				ok: true,
				output,
				exited: processExited,
				exitCode,
				...(newUrls.length > 0 ? { urls: newUrls } : {}),
				...(intercepted.length > 0 ? { intercepted } : {}),
				...(selfOpen ? { selfOpen } : {}),
			}),
		);
	}

	function waitForNewOutput(
		socket: Socket,
		sinceBytes: number,
		timeout: number,
		mode: OutputMode,
	) {
		if (bytesReceived > sinceBytes || processExited) {
			void respondWithOutput(socket, mode);
			return;
		}

		const waiter: Waiter = {
			resolve: () => void respondWithOutput(socket, mode),
			timer: setTimeout(() => {
				const idx = waiters.indexOf(waiter);
				if (idx !== -1) waiters.splice(idx, 1);
				void respondWithOutput(socket, mode);
			}, timeout),
		};
		waiters.push(waiter);
	}

	function writeToStdin(data: string | undefined) {
		lastStdinWrite = Date.now();
		stdin?.write(data);
	}

	function withSettleDelay(fn: () => void) {
		const now = Date.now();
		const elapsed = now - lastStdinWrite;
		const delay = Math.max(0, INPUT_SETTLE_MS - elapsed);
		if (delay > 0) {
			setTimeout(fn, delay);
		} else {
			fn();
		}
	}

	function handle(msg: DaemonMessage, socket: Socket) {
		const mode = msg.mode ?? "new";
		if (!OUTPUT_MODES.includes(mode)) {
			socket.end(
				JSON.stringify({ ok: false, error: `unknown output mode: ${mode}` }),
			);
			return;
		}
		switch (msg.action) {
			case "read":
				if (msg.wait) {
					const timeout = msg.timeout ?? 30000;
					// wait for output beyond what the client last saw
					waitForNewOutput(socket, lastReadBytes, timeout, mode);
				} else {
					void respondWithOutput(socket, mode);
				}
				break;

			case "send":
				if (processExited) {
					socket.end(JSON.stringify({ ok: false, error: "process exited" }));
					break;
				}
				withSettleDelay(() => {
					writeToStdin(msg.data);
					lastReadBytes = bytesReceived;
					socket.end(JSON.stringify({ ok: true }));
				});
				break;

			case "sendread": {
				if (processExited) {
					socket.end(JSON.stringify({ ok: false, error: "process exited" }));
					break;
				}
				const beforeBytes = bytesReceived;
				const timeout = msg.timeout ?? 30000;
				withSettleDelay(() => {
					writeToStdin(msg.data);
					waitForNewOutput(socket, beforeBytes, timeout, mode);
				});
				break;
			}

			case "stop":
				void persistOutput();
				proc.kill("SIGTERM");
				socket.end(JSON.stringify({ ok: true }));
				setTimeout(() => {
					server.close();
					try {
						unlinkSync(sock);
					} catch {}
					cleanupSession(sessionName);
					process.exit(0);
				}, 500);
				break;

			case "status":
				socket.end(
					JSON.stringify({
						ok: true,
						running: !processExited,
						pid: proc.pid,
						exitCode,
					}),
				);
				break;

			default:
				socket.end(JSON.stringify({ ok: false, error: "unknown action" }));
		}
	}

	server.listen(sock);
}
