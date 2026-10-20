import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { sessionsDir, socketPath } from "./paths";

test("defaults to ~/.noninteractive/sessions", () => {
	expect(sessionsDir({})).toBe(
		resolve(homedir(), ".noninteractive", "sessions"),
	);
});

test("NONINTERACTIVE_HOME overrides the sessions dir", () => {
	const env = { NONINTERACTIVE_HOME: "/tmp/ni-eval" };
	expect(sessionsDir(env)).toBe("/tmp/ni-eval/sessions");
	expect(socketPath("tide", env)).toBe("/tmp/ni-eval/sessions/tide.sock");
});

test("empty NONINTERACTIVE_HOME fails loudly", () => {
	expect(() => sessionsDir({ NONINTERACTIVE_HOME: "" })).toThrow(
		/NONINTERACTIVE_HOME is set but empty/,
	);
});

test("relative NONINTERACTIVE_HOME fails loudly", () => {
	expect(() => sessionsDir({ NONINTERACTIVE_HOME: ".firegoat/ni" })).toThrow(
		/must be an absolute path, got "\.firegoat\/ni"/,
	);
});

test("socket path over the unix limit names the limit and the path", () => {
	const env = { NONINTERACTIVE_HOME: `/${"x".repeat(100)}` };
	const expected = `/${"x".repeat(100)}/sessions/s.sock`;
	expect(() => socketPath("s", env, "darwin")).toThrow(
		`over the 103-byte unix socket limit on darwin: ${expected}`,
	);
	expect(() => socketPath("s", env, "linux")).toThrow(
		`over the 107-byte unix socket limit on linux: ${expected}`,
	);
});

const CLI = resolve(import.meta.dirname, "index.ts");

function cli(env: Record<string, string>, ...args: string[]) {
	const res = spawnSync(process.execPath, [CLI, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 20_000,
	});
	return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test("start/list/stop stay inside NONINTERACTIVE_HOME", async () => {
	// tmpdir, not a deep scratch dir: the socket path must fit the unix limit
	const home = mkdtempSync(resolve(tmpdir(), "ni-"));
	const name = `nihome-e2e-${process.pid}`;
	const realSessions = resolve(homedir(), ".noninteractive", "sessions");
	const leaked = () =>
		existsSync(realSessions) &&
		readdirSync(realSessions).some((f) => f.startsWith(name));
	const env = { NONINTERACTIVE_HOME: home };
	try {
		const start = cli(
			env,
			"start",
			"--name",
			name,
			"--no-open",
			"sh",
			"-c",
			"echo ni-home-session-ready; cat",
		);
		expect(start.code).toBe(0);
		expect(existsSync(resolve(home, "sessions", `${name}.sock`))).toBe(true);
		expect(existsSync(resolve(home, "sessions", name, "bin", "open"))).toBe(
			true,
		);

		const list = cli(env, "list");
		expect(list.out).toContain(`${name} [running]`);
		expect(cli({}, "list").out).not.toContain(name);

		expect(cli(env, "stop", name).code).toBe(0);
		await Bun.sleep(500);
		expect(existsSync(resolve(home, "sessions", name))).toBe(false);
		expect(leaked()).toBe(false);
	} finally {
		cli(env, "stop", name);
		rmSync(home, { recursive: true, force: true });
	}
}, 30_000);

test("invalid NONINTERACTIVE_HOME makes the CLI exit with the error", () => {
	const res = cli({ NONINTERACTIVE_HOME: "rel/dir" }, "list");
	expect(res.code).toBe(1);
	expect(res.out).toContain("NONINTERACTIVE_HOME must be an absolute path");
});
