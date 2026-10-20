import {
	type IBuffer,
	type IBufferLine,
	type IMarker,
	Terminal,
} from "@xterm/headless";

// must match pty.StartWithSize in ptybridge/main.go — the child lays out its
// output for that size, so a different emulator size would misplace redraws.
export const COLS = 80;
export const ROWS = 24;
export const SCROLLBACK = 5000;

// erase / line-edit sequences: a redraw (menu repaint, readline refresh) goes
// through these, so the row they hit counts as touched even if it ends up with
// the same text. J with mode 1+ reaches up to the top of the viewport.
const ROW_EDITS = ["K", "J", "L", "M", "P", "X", "@"] as const;

// where the last takeNew() left off: the cursor row, as a marker so it follows
// scrolling and scrollback trimming, plus the viewport rows above it as they were
// returned (to spot redraws above the mark that bypass the erase sequences).
interface Mark {
	cursor: IMarker;
	above: string[];
}

export class Screen {
	private readonly term = new Terminal({
		cols: COLS,
		rows: ROWS,
		scrollback: SCROLLBACK,
		allowProposedApi: true,
	});
	private mark: Mark | null = null;
	// lowest row touched by an erase/edit since the mark, relative to the mark
	private touchedFromMark = 0;
	private dirty = false;
	private lastBuffer: IBuffer["type"] = "normal";

	constructor() {
		for (const final of ROW_EDITS) {
			this.term.parser.registerCsiHandler({ final }, (params) => {
				this.touch(final === "J" && Number(params[0]) > 0);
				return false; // let xterm's own handler run
			});
		}
	}

	write(data: string | Uint8Array): Promise<void> {
		this.dirty = true;
		return new Promise((resolve) => this.term.write(data, resolve));
	}

	// resolves once every write queued so far has been parsed
	flush(): Promise<void> {
		return new Promise((resolve) => this.term.write("", resolve));
	}

	// rows touched since the previous call (redraws in their final state) through
	// the last non-empty row. in the alternate screen: the whole screen.
	takeNew(): string {
		const buf = this.term.buffer.active;
		const switched = buf.type !== this.lastBuffer;
		this.lastBuffer = buf.type;
		if (!this.dirty && !switched) return "";
		this.dirty = false;
		if (buf.type === "alternate") return this.screen();

		const start = this.firstNewRow(buf);
		this.placeMark(buf);
		return render(buf, start, buf.length).replace(/^(?:[ \t]*\n)+/, "");
	}

	screen(): string {
		const buf = this.term.buffer.active;
		return render(buf, buf.baseY, buf.baseY + ROWS);
	}

	all(): string {
		const buf = this.term.buffer.active;
		return render(buf, 0, buf.length);
	}

	private touch(viewportTop: boolean) {
		const buf = this.term.buffer.active;
		const mark = this.mark;
		if (buf.type !== "normal" || !mark || mark.cursor.isDisposed) return;
		const row = buf.baseY + (viewportTop ? 0 : buf.cursorY);
		this.touchedFromMark = Math.min(
			this.touchedFromMark,
			row - mark.cursor.line,
		);
	}

	private firstNewRow(buf: IBuffer): number {
		const mark = this.mark;
		if (!mark || mark.cursor.isDisposed) return 0;
		const markRow = mark.cursor.line;
		if (markRow < 0) throw new Error(`screen: live marker at row ${markRow}`);
		let first = Math.max(0, markRow + this.touchedFromMark);
		const top = markRow - mark.above.length;
		for (let row = Math.max(top, 0); row < first; row++) {
			if (rowText(buf, row) !== mark.above[row - top]) {
				first = row;
				break;
			}
		}
		return first;
	}

	private placeMark(buf: IBuffer) {
		this.mark?.cursor.dispose();
		const cursor = this.term.registerMarker(0);
		if (!cursor) throw new Error("screen: failed to register cursor marker");
		const above: string[] = [];
		for (let row = buf.baseY; row < cursor.line; row++)
			above.push(rowText(buf, row));
		this.mark = { cursor, above };
		this.touchedFromMark = 0;
	}
}

function rowText(buf: IBuffer, row: number): string {
	const line = buf.getLine(row);
	if (!line)
		throw new Error(`screen: row ${row} out of range (length ${buf.length})`);
	return styledText(line, true);
}

// renders rows [from, to) as logical lines: soft-wrapped rows are rejoined so
// long urls survive, trailing blank lines are dropped.
function render(buf: IBuffer, from: number, to: number): string {
	let row = from;
	while (row > 0 && buf.getLine(row)?.isWrapped) row--;
	const end = Math.min(to, buf.length);
	const lines: string[] = [];
	for (; row < end; row++) {
		const line = buf.getLine(row);
		if (!line)
			throw new Error(`screen: row ${row} out of range (length ${buf.length})`);
		const wrapsOn = row + 1 < end && buf.getLine(row + 1)?.isWrapped === true;
		const text = styledText(line, !wrapsOn);
		if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
		else lines.push(text);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

// bold / inverse spans become **markers** (menus often mark the selected item
// that way), as the old ansi stripper did. underline is left out: clis underline
// links (and xterm underlines osc-8 hyperlinks), and "**https://…**" breaks urls.
function styledText(line: IBufferLine, trimRight: boolean): string {
	let out = "";
	let span = "";
	let styled = false;
	const close = () => {
		const core = span.trim();
		if (styled && core) {
			const lead = span.slice(0, span.indexOf(core));
			out += `${lead}**${core}**${span.slice(lead.length + core.length)}`;
		} else out += span;
		span = "";
	};
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x);
		if (!cell) throw new Error(`screen: missing cell ${x}`);
		if (cell.getWidth() === 0) continue;
		const emphasis = Boolean(cell.isBold() || cell.isInverse());
		if (emphasis !== styled) {
			close();
			styled = emphasis;
		}
		span += cell.getChars() || " ";
	}
	close();
	return trimRight ? out.trimEnd() : out;
}
