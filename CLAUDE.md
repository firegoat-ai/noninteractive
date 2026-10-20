# noninteractive CLI

Session wrapper for interactive CLI commands. Lets claude code run interactive login flows non-interactively.

## Architecture

- `src/index.ts` — CLI entry point, arg parsing, auto-start flow
- `src/daemon.ts` — detached daemon per session, spawns target command, unix socket server
- `src/client.ts` — connects to daemon via unix socket, sends JSON commands
- `src/paths.ts` — session dir/socket path helpers
- `src/screen.ts` — per-session virtual terminal (`@xterm/headless`, pinned 6.0.0, bundled into bin/) with `takeNew`/`screen`/`all` rendering
- `ptybridge/main.go` — Go PTY bridge source, allocates real terminal for child process
- `native/ptybridge-{os}-{arch}` — compiled Go PTY binaries (darwin-arm64, darwin-amd64, linux-amd64, linux-arm64)

Sessions stored at `~/.noninteractive/sessions/<name>.sock`. Protocol is JSON over unix socket.

## Commands

```
noninteractive start <name> [args...]          # start session (runs npx <name> in a PTY)
noninteractive send  <name> <text> [--wait] [--screen|--all]   # send keystrokes, print what changed
noninteractive read  <name> [--wait] [--screen|--all]          # print output since the last send/read
noninteractive stop  <name>                    # stop a session
noninteractive list                            # show active sessions (alias: ls)
```

The `--wait` flag on `send` and `read` blocks until new output appears (default 30s timeout, configurable with `--timeout <ms>`). The daemon-side action for `send --wait` is `sendread`.

Output is rendered, not stripped: the daemon feeds every PTY chunk into a `Screen` (xterm headless, 80x24 to match `pty.StartWithSize` in ptybridge, 5000 lines scrollback), so redraws (arrow menus, readline `ESC[1G ESC[0J`, `ESC[2K` repaints) collapse to their final state. Request field `mode`: `new` (default — rows touched since the previous response, from the cursor row the last response ended on, through the last non-empty row; erase/line-edit CSI handlers and a diff of the rows above the mark catch redraws that move up), `screen` (viewport), `all` (scrollback + viewport). Every response advances the `new` cursor. Bold/inverse → `**text**` (underline deliberately not: it wraps links). Soft-wrapped rows are rejoined so long URLs stay whole. `[exited N]` is printed once by the client from `exitCode`; on exit/stop the daemon saves rendered `all()` + `[exited N]` to `<name>.output` for reads after it shuts down. Self-open detection (`announcesSelfOpen`) runs in the daemon over rendered output handed out since the last url-bearing response and is sent as `selfOpen`.

## Build

```
bun run build      # compiles to bin/noninteractive standalone binary
bun run build:pty  # cross-compiles Go PTY bridge for all platforms
```

## URL interception

OAuth/browser URLs are auto-detected, surfaced to the agent, and the single auth URL the human needs is auto-opened (selective — never every URL). Three layers:

1. **Shadow scripts** — `open`/`xdg-open`/`browser-open` wrappers in `~/.noninteractive/sessions/<name>/bin/` intercept browser-open calls and write URLs to a file. Session bin dir prepended to PATH, `BROWSER` env points to `browser-open` script.
2. **Output scanning** — daemon scans stdout/stderr for `https?://` URLs. Scanned (prose) URLs are trimmed of trailing sentence punctuation (`.,;:!?'"`) and OSC-8 / CSI escapes are stripped first (so colored or hyperlinked links survive whole, and two links glued by a stripped color code are re-split); intercepted URLs (the exact argv a child passed to `open`) are kept verbatim. The daemon tracks which URLs it *intercepted* via the shim (vs only saw in stdout) and reports each URL to the client once (across all send/read calls), with an `intercepted` list, so nothing is re-surfaced or re-opened on a buffer rescan. URL helpers live in `src/urls.ts`.
3. **Client-side selective auto-open** — client prints every new URL to stderr. It auto-opens *only* the first high-confidence auth URL via `open`/`xdg-open`, matched by a tight pattern (`authorize|activate|oauth|device|confirm_auth|cli-auth|cli/login|/callback|login_code|token-flow|stripecli` — `isAutoOpenUrl`/`pickAutoOpenUrl`). At most one tab per process so login flows don't scatter; docs/signup/marketing/release links are surfaced but never opened. A broader `isAuthUrl` is used only to *label* `[login url: …]`. **Self-open dedupe:** the client opens a URL only if the shim *intercepted* it (the CLI's own PATH `open` was captured & suppressed → we must open it: auth0, daytona) OR — for stdout-only URLs — if the CLI did NOT announce "opening/launching … browser" (`announcesSelfOpen`). CLIs that open their own tab via native macOS APIs the shim can't catch (railway, supabase) announce it and bypass interception, so we skip them to avoid a duplicate tab. The announcement match is present-continuous only, so auth0's past-tense "opened browser window" (it relies on us) is not mistaken for a self-open. `--no-open` suppresses opening entirely (URLs still surfaced). Rationale: the prior all-or-nothing auto-open popped incidental tabs during logins; `--no-open` alone breaks CLIs like auth0 that don't self-open under the PTY (issue #10).

Session dirs (bin/, urls file) cleaned up on stop/exit.

## AX evals (firegoat)

`firegoat.yaml` holds 3 agent-experience evals (quickstart `npm init`, arrow-key menu wizard, node REPL lifecycle). Run with `npx -y firegoat@0.9.0 eval --json`; results land in `.firegoat/runs/` (ignored). Setup packs the local build and installs the tgz into each workdir — a PATH-only binary doesn't work because `npx noninteractive` falls back to the registry. Each eval run rebuilds `bin/`. Fixtures live in `evals/fixtures/` (setup copies them to `$FIREGOAT_OUT`; not shipped — package.json `files` whitelists only bin/native). Run with `env -u ANTHROPIC_API_KEY` or firegoat bills the API key instead of the claude login. Known friction surfaced: `send` returns the full transcript incl. every menu redraw, `list` lags right after `stop`, dead sessions never pruned from `~/.noninteractive`.

## Notes

- daemon uses node:child_process and node:net (not Bun-specific APIs) for subprocess/socket — needed for detached spawn and unix socket server
- PTY via Go binary (ptybridge/) using github.com/creack/pty — allocates a real pseudo-terminal so child processes see isTTY=true
- Go binaries are ~2.5MB each, shipped for darwin/linux x arm64/amd64
- no python3 dependency — everything is self-contained
- compiled bun binary is ~55MB (includes bun runtime)

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
