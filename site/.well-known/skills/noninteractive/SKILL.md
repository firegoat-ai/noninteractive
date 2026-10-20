---
name: noninteractive
description: Run interactive CLI commands (setup wizards, login flows, installers) non-interactively using npx noninteractive. Use when you need to run a CLI tool that has interactive prompts, OAuth flows, or terminal-based menus that cannot be bypassed with flags.
compatibility: Requires Node.js 18+ or Bun. Works on macOS and Linux (x86_64, arm64).
allowed-tools: Bash(npx noninteractive *)
argument-hint: "<tool> [args...]"
metadata:
  author: 2027dev
  version: "1.8"
---

# noninteractive

Use `npx noninteractive` to drive interactive CLI tools without a human. It spawns commands in a real pseudo-terminal (PTY) and lets you send keystrokes and read output programmatically.

## When to use this skill

Use noninteractive when:
- A CLI tool requires interactive input (setup wizards, login flows, confirmation prompts)
- There is no `--yes`, `--non-interactive`, or `--headless` flag available
- The command uses terminal menus (@clack/prompts, inquirer, etc.)
- You need to complete an OAuth or authentication flow in a CLI

Do NOT use noninteractive when:
- The CLI tool has a non-interactive mode or `--yes` flag — use that instead
- You're running a simple command that doesn't need user input

## Quick start

If arguments were provided, run:

```bash
npx noninteractive $ARGUMENTS
```

Read the initial output, then drive the session using the workflow below.

## Commands

```
npx noninteractive <tool> [args...]                  # Start a session (runs npx <tool>)
npx noninteractive send <session> <text>             # Send keystrokes, RETURNS output
npx noninteractive read <session> --wait             # Wait for output without sending
npx noninteractive stop <session>                    # Stop session
npx noninteractive list                              # Show active sessions
```

Use `--no-wait` with `send` to fire-and-forget (don't wait for output).

## Critical: `send` parses escape sequences

**`send` parses C-style escape sequences in the text argument.** Use regular double quotes — no shell `$'...'` quoting needed.

```bash
# Press Enter (empty string = Enter)
npx noninteractive send <session> ""

# Press Enter (explicit)
npx noninteractive send <session> "\r"

# Type text + Enter
npx noninteractive send <session> "my-project-name\r"

# Type 'y' + Enter
npx noninteractive send <session> "y\r"

# Arrow down (no Enter — just navigates)
npx noninteractive send <session> "\x1b[B"

# Arrow down twice, then Enter to confirm
npx noninteractive send <session> "\x1b[B\x1b[B\r"
```

**`send` returns what changed on screen since your last `send`/`read`** (the next prompt, the repainted menu in its final state). You do NOT need to call `read` after `send`, and you never need to pipe through `tail`/`head`.

The correct workflow is: **start → send → send → ... → stop**

Only use `read --wait` when you need to wait for output *without* sending anything (e.g., waiting for an OAuth callback).

## Special keys reference

```
""          Enter (shorthand — empty string auto-converts to \r)
"\r"        Enter / Return
"\x1b[A"    Arrow Up
"\x1b[B"    Arrow Down
"\x1b[C"    Arrow Right
"\x1b[D"    Arrow Left
"\t"        Tab
"\x1b"      Escape
"\x7f"      Backspace
```

You can combine multiple keys in one send: `"\x1b[B\x1b[B\r"` = down, down, enter.

Many CLI prompts (@clack/prompts, inquirer) also accept **vim keys**: `j` = down, `k` = up, `h` = left, `l` = right. These are more reliable than arrow escape sequences in PTY contexts.

## Step-by-step workflow

### 1. Start a session

```bash
npx noninteractive <tool-name> [args...]
```

This runs `npx <tool-name>` in a background PTY. The session name is the tool name (e.g., `npx noninteractive workos` → session `workos`). The start command prints initial output.

**Prefer the simple form.** Pass the tool directly: `npx noninteractive sanity@latest login`, not `npx noninteractive -- npx sanity@latest login`. The session name is derived from the first argument, so using `-- npx` would name the session `npx` instead of `sanity`.

**First run may be slow**: If npx needs to install the package, the first command can take 30-60+ seconds. Use `--timeout 60000` (or higher) on your first `send` or `read --wait`.

### 2. Send input and get response

```bash
# Press Enter (confirm/select current option), get response
npx noninteractive send <session> ""

# Type text and press Enter, get response
npx noninteractive send <session> "my-project-name\r"

# Navigate down two options, then confirm
npx noninteractive send <session> "\x1b[B\x1b[B\r"

# Just navigate without confirming
npx noninteractive send <session> "\x1b[B" --no-wait
```

**Do not call `read` after `send`** — the output is already in the response.

### 3. Wait without sending (OAuth flows, long operations)

```bash
npx noninteractive read <session> --wait --timeout 60000
```

Use `read --wait` only when waiting for something to happen without sending input — e.g., waiting for an OAuth callback or a long build.

### 4. Stop the session

```bash
npx noninteractive stop <session>
```

## Complete example: WorkOS CLI setup

```bash
# Start the WorkOS installer (prints initial output)
npx noninteractive workos
# Output: ◆  Run the AuthKit installer?  │  ● Yes / ○ No  └

# Press Enter to select "Yes" — response includes next prompt
npx noninteractive send workos ""
# Output: ◆  You are on main. Create a feature branch?  │  ● Create feat/add-workos-authkit  └

# Press Enter to confirm — response includes next prompt
npx noninteractive send workos ""

# Type API key + Enter — response includes next prompt
npx noninteractive send workos "my-api-key\r"

# Done
npx noninteractive stop workos
```

## Important details

- **`send` returns output by default**: Do not follow it with `read`. The output is already there. Use `--no-wait` to fire-and-forget.
- **Escape sequences are parsed**: `\r` = Enter, `\x1b[B` = arrow down, etc. Use regular double quotes, not `$'...'`.
- **Empty string = Enter**: `send session ""` is the easiest way to press Enter.
- **Rendered output**: Output goes through a terminal emulator, so it is clean text — menus and prompts that redraw show their final state once. Bold/inverse text is marked `**like this**`.
- **First run timeout**: npx may need to install the package. Use `--timeout 60000` or higher on the first wait.
- **Output is incremental**: each `send`/`read` prints only what is new since the previous one (`[no new output]` if nothing changed). Add `--screen` for the current 80x24 screen or `--all` for the whole rendered history.
- **Sessions persist**: Sessions run as background daemons. Use `list` to see active sessions.
- **Parallel sessions**: If a session name is already taken, a suffix is added automatically (e.g., `eslint`, `eslint-2`, `eslint-3`).
- **Real PTY**: The child process sees `isTTY=true`. Terminal menus and raw mode work correctly.
- **Default timeout**: `send` and `read --wait` default to 30s. Use `--timeout <ms>` to change.
- **OAuth URLs auto-open**: URLs detected in output are automatically opened in the browser. Use `--no-open` to disable.

## Handling common patterns

### Arrow key navigation

Use escape sequences to navigate menus. Arrow keys alone do NOT confirm — send `"\r"` separately or combine: `"\x1b[B\r"`.

```bash
# Move down and confirm
npx noninteractive send <session> "\x1b[B\r"

# Move down twice without confirming
npx noninteractive send <session> "\x1b[B\x1b[B" --no-wait
```

### Yes/No toggle prompts

Most Yes/No toggles default to the correct option. **Just press Enter** — don't send arrow keys unless you need to change the selection.

```bash
# Accept the default (usually Yes)
npx noninteractive send <session> ""

# Switch selection: use vim keys (more reliable than arrow keys in PTY)
npx noninteractive send <session> "l" --no-wait   # move right (No → Yes)
npx noninteractive send <session> "h" --no-wait   # move left (Yes → No)
npx noninteractive send <session> ""               # then confirm with Enter
```

The `◉` symbol in output means "selected", `◯` means "not selected".

### OAuth/browser flows
URLs detected in output are automatically opened in the user's browser. The CLI intercepts `open`/`xdg-open` calls and scans output for URLs.

1. Start the session — any OAuth URL will be auto-opened in the browser
2. Tell the user to complete authentication in the opened browser tab
3. Use `read --wait --timeout 60000` to block until the CLI detects the completed auth

Use `--no-open` to disable auto-opening (URLs are still shown in stderr).

### Multiple sessions
```bash
npx noninteractive vercel
npx noninteractive workos
npx noninteractive list  # Shows both sessions
```
