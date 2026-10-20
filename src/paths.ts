import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const HOME_ENV = "NONINTERACTIVE_HOME";

// sun_path is 104 bytes on macOS/BSD and 108 on linux, including the trailing NUL
export function maxSocketPathLength(platform: string = process.platform) {
	return (platform === "linux" ? 108 : 104) - 1;
}

export function noninteractiveHome(env = process.env) {
	const value = env[HOME_ENV];
	if (value === undefined) return resolve(homedir(), ".noninteractive");
	if (value === "") {
		throw new Error(
			`${HOME_ENV} is set but empty. set it to an absolute directory or unset it to use ~/.noninteractive`,
		);
	}
	if (!isAbsolute(value)) {
		throw new Error(
			`${HOME_ENV} must be an absolute path, got "${value}". try ${HOME_ENV}="$PWD/${value}"`,
		);
	}
	return resolve(value);
}

export function sessionsDir(env = process.env) {
	return resolve(noninteractiveHome(env), "sessions");
}

export function ensureSessionsDir() {
	mkdirSync(sessionsDir(), { recursive: true });
}

export function socketPath(
	name: string,
	env = process.env,
	platform: string = process.platform,
) {
	const path = resolve(sessionsDir(env), `${name}.sock`);
	const limit = maxSocketPathLength(platform);
	if (Buffer.byteLength(path) > limit) {
		throw new Error(
			`socket path is ${Buffer.byteLength(path)} bytes, over the ${limit}-byte unix socket limit on ${platform}: ${path}\n` +
				`use a shorter session name or a shorter ${HOME_ENV}`,
		);
	}
	return path;
}

export function sessionDir(name: string) {
	return resolve(sessionsDir(), name);
}

export function sessionBinDir(name: string) {
	return resolve(sessionsDir(), name, "bin");
}

export function sessionUrlsFile(name: string) {
	return resolve(sessionsDir(), name, "urls");
}

export function sessionOutputFile(name: string) {
	return resolve(sessionsDir(), `${name}.output`);
}
