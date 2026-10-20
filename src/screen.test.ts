import { expect, test } from "bun:test";
import { COLS, ROWS, SCROLLBACK, Screen } from "./screen";
import { extractUrls } from "./urls";

const MENU_ITEMS = [
	"us-east-1",
	"us-west-2",
	"eu-west-1",
	"eu-central-1",
	"ap-southeast-1",
];
const menu = (selected: number) =>
	MENU_ITEMS.map((item, i) =>
		i === selected
			? `\x1b[2K\x1b[36m> ${item}\x1b[0m\r\n`
			: `\x1b[2K  ${item}\x1b[0m\r\n`,
	).join("");

test("size matches ptybridge's pty.StartWithSize", async () => {
	const src = await Bun.file(
		`${import.meta.dirname}/../ptybridge/main.go`,
	).text();
	expect(src).toContain(`pty.Winsize{Rows: ${ROWS}, Cols: ${COLS}}`);
});

test("arrow menu repaint renders one clean menu", async () => {
	const s = new Screen();
	await s.write("\x1b[1G\x1b[0J? Service name: \x1b[17Gx\r\r\n");
	await s.write("? Region: (use arrow keys, enter to confirm)\r\n");
	await s.write(menu(0));
	expect(s.takeNew()).toContain("> us-east-1");
	for (let i = 1; i <= 3; i++) await s.write(`\x1b[5A${menu(i)}`);
	const out = s.takeNew();
	expect(out).toBe(
		MENU_ITEMS.map((m, i) => (i === 3 ? `> ${m}` : `  ${m}`)).join("\n"),
	);
	expect(s.all()).toBe(
		[
			"? Service name: x",
			"? Region: (use arrow keys, enter to confirm)",
			...MENU_ITEMS.map((m, i) => (i === 3 ? `> ${m}` : `  ${m}`)),
		].join("\n"),
	);
});

test("each single-step repaint returns the whole menu, also once the screen has scrolled", async () => {
	const s = new Screen();
	let banner = "";
	for (let i = 0; i < ROWS * 2; i++) banner += `banner ${i}\r\n`;
	await s.write(`${banner}? Region:\r\n${menu(0)}`);
	s.takeNew();
	for (let i = 1; i <= 3; i++) {
		await s.write(`\x1b[5A${menu(i)}`);
		expect(s.takeNew()).toBe(
			MENU_ITEMS.map((m, j) => (j === i ? `> ${m}` : `  ${m}`)).join("\n"),
		);
	}
});

test("prompts after the screen has scrolled return only the new lines", async () => {
	const s = new Screen();
	let banner = "";
	for (let i = 0; i < ROWS * 2; i++) banner += `banner ${i}\r\n`;
	await s.write(`${banner}name: `);
	s.takeNew();
	await s.write("ada\r\nage: ");
	expect(s.takeNew()).toBe("name: ada\nage:");
	await s.write("36\r\n");
	expect(s.takeNew()).toBe("age: 36");
});

test("node repl redraw shows the final line once", async () => {
	const s = new Screen();
	await s.write(
		"> \x1b[1G\x1b[0J> r\x1b[4G\x1b[1G\x1b[0J> re\x1b[5G\x1b[1G\x1b[0J> req\x1b[6G",
	);
	expect(s.takeNew()).toBe("> req");
});

test("sequential prompts: takeNew returns only what's new", async () => {
	const s = new Screen();
	await s.write(
		"This utility will walk you through creating a package.json file.\r\n\r\n",
	);
	await s.write("package name: (tmp) ");
	expect(s.takeNew()).toBe(
		"This utility will walk you through creating a package.json file.\n\npackage name: (tmp)",
	);
	await s.write("tide-clock\r\nversion: (1.0.0) ");
	expect(s.takeNew()).toBe("package name: (tmp) tide-clock\nversion: (1.0.0)");
	await s.write("0.1.0\r\ndescription: ");
	expect(s.takeNew()).toBe("version: (1.0.0) 0.1.0\ndescription:");
	expect(s.takeNew()).toBe("");
});

test("escape and utf-8 split across chunks", async () => {
	const s = new Screen();
	const bytes = new TextEncoder().encode(
		"héllo \x1b[1mbold\x1b[0m ✓\r\n\x1b[1Aover",
	);
	for (const b of bytes) await s.write(new Uint8Array([b]));
	expect(s.takeNew()).toBe("overo **bold** ✓");
});

test("osc-8 hyperlink keeps the visible text, url still extractable from raw bytes", async () => {
	const s = new Screen();
	const raw =
		"open \x1b]8;;https://example.com/device?code=AB\x07https://example.com/device?code=AB\x1b]8;;\x1b\\ now\r\n";
	await s.write(raw.slice(0, 12));
	await s.write(raw.slice(12));
	const out = s.takeNew();
	expect(out).toBe("open https://example.com/device?code=AB now");
	expect(extractUrls(out)).toEqual(["https://example.com/device?code=AB"]);
	expect(extractUrls(raw)).toContain("https://example.com/device?code=AB");
});

test("alt screen shows the full alt viewport, exit restores the normal buffer", async () => {
	const s = new Screen();
	await s.write("$ before\r\n");
	s.takeNew();
	await s.write("\x1b[?1049h\x1b[H\x1b[2JTUI header\r\n  item");
	expect(s.takeNew()).toBe("TUI header\n  item");
	expect(s.screen()).toBe("TUI header\n  item");
	await s.write("\x1b[?1049lafter\r\n");
	expect(s.takeNew()).toBe("after");
	expect(s.all()).toBe("$ before\nafter");
});

test("long lines wrap at 80 cols but render as one logical line", async () => {
	const s = new Screen();
	const url = `https://example.com/oauth/authorize?${"x".repeat(150)}`;
	await s.write(`${url}\r\nnext`);
	expect(s.takeNew()).toBe(`${url}\nnext`);
	expect(s.screen().split("\n")[0]).toBe(url);
});

test("scrollback is capped and takeNew survives trimming", async () => {
	const s = new Screen();
	await s.write("first\r\n");
	s.takeNew();
	let chunk = "";
	for (let i = 0; i < SCROLLBACK + 100; i++) chunk += `line ${i}\r\n`;
	await s.write(chunk);
	const all = s.all().split("\n");
	expect(all.length).toBe(SCROLLBACK + ROWS - 1);
	expect(all.at(-1)).toBe(`line ${SCROLLBACK + 99}`);
	expect(all[0]).not.toBe("first");
	expect(s.takeNew().split("\n").length).toBe(SCROLLBACK + ROWS - 1);
	await s.write("tail\r\n");
	expect(s.takeNew()).toBe("tail");
});

test("bold/inverse become ** markers (not underline), whitespace stays outside", async () => {
	const s = new Screen();
	await s.write("\x1b[7m  selected  \x1b[0m plain \x1b[4munder\x1b[0m\r\n");
	expect(s.takeNew()).toBe("  **selected**   plain under");
});

test("screen clear then repaint returns the repainted rows", async () => {
	const s = new Screen();
	await s.write("old a\r\nold b\r\n");
	s.takeNew();
	await s.write("\x1b[H\x1b[2Jnew a\r\n");
	expect(s.takeNew()).toBe("new a");
});
