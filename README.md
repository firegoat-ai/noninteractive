# noninteractive

Run interactive CLI login flows non-interactively. Built for AI agents (like Claude Code) that need to complete setup wizards, OAuth flows, and interactive installers without a human at the keyboard.

Spawns commands in a real PTY session, so programs that check `isTTY`, render select menus, or use raw terminal mode all work correctly.

## Install

```bash
npx noninteractive
```

## Usage

```bash
# Start a session (runs `npx workos` in a background PTY)
npx noninteractive workos

# Send keystrokes and wait for new output
npx noninteractive send workos "" --wait

# Send text input and wait for response
npx noninteractive send workos "my-api-key" --wait

# Wait for new output without sending (e.g. OAuth callback)
npx noninteractive read workos --wait

# Read output since the last send/read (non-blocking)
npx noninteractive read workos

# Show the whole current screen / the full rendered history
npx noninteractive read workos --screen
npx noninteractive read workos --all

# Stop a session
npx noninteractive stop workos

# List active sessions
npx noninteractive list
```

## Example: WorkOS AuthKit setup

```bash
# Start the installer
npx noninteractive workos
# ◆  Run the AuthKit installer?
# │  ● Yes / ○ No
# └

# Press Enter to confirm "Yes", wait for next prompt
npx noninteractive send workos "" --wait
# ◆  You are on main. Create a feature branch?
# │  ● Create feat/add-workos-authkit
# │  ○ Continue on current branch
# │  ○ Cancel
# └

# Press Enter to confirm
npx noninteractive send workos "" --wait

# Done? Stop the session
npx noninteractive stop workos
```

## The `--wait` flag

Both `send` and `read` support `--wait` (`-w`), which blocks until new output appears instead of returning immediately. This eliminates polling loops and reduces tool calls by ~7-10x. Output is rendered through a headless terminal emulator ([xterm.js](https://github.com/xtermjs/xterm.js), bundled), so agents get clean text: arrow-key menus, spinners and readline redraws show their final state once instead of every repaint stacked up.

Each `send`/`read` prints only what is **new since the previous `send`/`read`** — the next prompt, or the menu as it now looks — so there is no need to pipe through `tail`. Two flags change that:

```bash
npx noninteractive read workos --screen   # the current 80x24 screen
npx noninteractive read workos --all      # the whole rendered history (scrollback)
```

```bash
# Old way (polling): send + read + read + read...
npx noninteractive send workos ""
npx noninteractive read workos        # maybe not ready yet
npx noninteractive read workos        # still waiting...
npx noninteractive read workos        # finally got output

# New way (blocking): send --wait
npx noninteractive send workos "" --wait   # returns when output appears
```

Use `--timeout <ms>` to set the max wait time (default: 30000ms).

## Agent Skill

Install the [Agent Skill](https://agentskills.io) so your AI agent knows how to use noninteractive:

```bash
npx skills add https://noninteractive.org
```

## How it works

1. `npx noninteractive <tool>` spawns a detached daemon that runs `npx <tool>` inside a real pseudo-terminal (PTY)
2. The daemon listens on a unix socket at `~/.noninteractive/sessions/<name>.sock`
3. `send --wait` sends keystrokes and blocks until new output appears — one call instead of polling
4. `read --wait` blocks until output changes — perfect for OAuth flows and long operations
5. The PTY ensures the child process sees a real terminal — `isTTY` is true, ANSI colors work, interactive menus render correctly

## Why

AI coding agents can run shell commands, but they can't interact with prompts that wait for user input. This tool bridges that gap — the agent starts the command, reads the output, decides what to send, and completes the flow autonomously.

## Agent Arena

This tool powers [2027.dev/arena](https://2027.dev/arena) — a benchmark that sends Claude Code through every devtool's getting-started guide to measure how agent-friendly they are. If an agent can't navigate your product, it won't use it.

Learn more about why this matters at [2027.dev/manifesto](https://2027.dev/manifesto).
