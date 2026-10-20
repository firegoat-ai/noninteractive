import { createConnection } from "node:net";

export type OutputMode = "new" | "screen" | "all";

export interface DaemonResponse {
	ok: boolean;
	output?: string;
	exited?: boolean;
	exitCode?: number | null;
	running?: boolean;
	pid?: number;
	error?: string;
	urls?: string[];
	intercepted?: string[];
	selfOpen?: boolean;
}

export function sendMessage(
	sockPath: string,
	msg: Record<string, unknown>,
	timeoutMs?: number,
): Promise<DaemonResponse> {
	const effectiveTimeout = timeoutMs ?? 5000;
	return new Promise((resolve, reject) => {
		const socket = createConnection(sockPath);
		let data = "";
		let resolved = false;

		let timer: ReturnType<typeof setTimeout>;

		function tryResolve() {
			if (resolved) return;
			try {
				const parsed = JSON.parse(data);
				resolved = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(parsed);
			} catch {}
		}

		socket.on("connect", () => {
			socket.write(JSON.stringify(msg));
		});

		socket.on("data", (chunk) => {
			data += chunk.toString();
			tryResolve();
		});

		socket.on("end", () => {
			tryResolve();
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(new Error("invalid response from daemon"));
			}
		});

		socket.on("error", (err: NodeJS.ErrnoException) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
				reject(new Error("session not found"));
			} else {
				reject(err);
			}
		});

		timer = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			socket.destroy();
			reject(new Error("connection timeout"));
		}, effectiveTimeout);
	});
}
