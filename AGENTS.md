# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex) working in this repository. CLAUDE.md imports it.

Divs & Spans is a design canvas that LLMs draw on over MCP: the agent writes HTML/CSS frames, the canvas renders them live, and people point back at files, frames or single elements with links. No design tooling (layers, shapes, pen) on purpose. One Cloudflare Worker serves the MCP endpoint, the JSON/WebSocket API and the canvas. Live at https://divsandspans.com (custom domains in wrangler.jsonc; workers.dev is kept on so older links and connectors keep working, and `www` 308-redirects to the apex in src/index.ts). Links are built from the request origin, so they follow whichever host the client used. README.md has the full feature and keyboard reference.

## Commands

```sh
npm run dev         # wrangler dev on :8787 (also runs build:web and watches src/ and web/)
npm run smoke       # in a second terminal: end-to-end MCP run against :8787 (pass a base URL to target another host)
npm run typecheck   # tsc for the worker (src/) and the canvas (web/), separate tsconfigs
npm run build:web   # esbuild web/canvas.ts + web/home.ts -> public/js (gitignored, built by wrangler)
npm run deploy      # wrangler deploy
npm run weekly      # Analytics Engine report; needs CF_ACCOUNT_ID and CF_API_TOKEN
```

There is no unit test suite. Verification is `typecheck` plus `smoke` (scripts/smoke.mjs plays the agent through a real MCP client: create file, claim/write frames, tokens, element links, lock and version conflicts). It asserts the exact tool count, so update it when adding or removing an MCP tool.

## Architecture

- **src/index.ts** is the Worker entry and router. `/mcp` goes to src/mcp.ts; `/f/<file>[/<frame>]` serves `public/canvas.html`; `/api/files/...` covers file state, the WebSocket, `tokens.css` and frame `render`/`source`. Everything else falls through to static assets. `run_worker_first` in wrangler.jsonc must list any new worker-handled path prefix.
- **src/mcp.ts** is a stateless Streamable HTTP MCP server (a fresh `McpServer` per request). Tools are wrapped by `wrap()`, which records analytics and turns thrown errors into tool errors; `errorKind()` classifies errors by message text, so keep error wording consistent with it. `CONTRACT` is the server `instructions` and the only design guidance the agent gets. It is deliberately structural, never taste.
- **src/design-file.ts** is the `DesignFile` Durable Object, one per file (`idFromName(fileId)`), SQLite-backed. The worker and MCP call its methods over DO RPC (`stub.getState()`, `stub.writeFrame()`, …); only the WebSocket goes through `fetch`. Every mutation calls `broadcast()` so open canvases update live. It owns claims (`start_frame` takes a 10-minute lock, `write_frame` needs the lock token, `base_version` rejects stale writes). The schema is created on `init()` with `CREATE TABLE IF NOT EXISTS` and there is no migration layer, so a new column needs an explicit `ALTER TABLE` path for existing files. Lookups must not write before `init()` (`ready` flag), or every probe becomes a stored object.
- **src/html.ts** does document normalization, `data-ds` id stamping (HTMLRewriter; ids survive rewrites so links keep working, duplicates get fresh ids), canvas rendering (injects tokens.css before the frame's own styles, forces theme), element resolution for `#element` links, the flow map and lint. Lint is consistency only (colors/fonts not in tokens, single scheme, no tokens used), never layout or style opinions.
- **src/screenshot.ts** renders frame PNGs with Browser Run (`@cloudflare/puppeteer`, `BROWSER` binding, a local Chromium under `wrangler dev`). The canvas sends its current view (device, theme, `D`, `H`) as query params and the PNG mirrors it; src/index.ts caches PNGs in the Cache API keyed on frame + tokens version + view. Each frame sits in a sandboxed iframe without `allow-scripts`. **src/chrome.ts** holds the device chrome markup and CSS shared by the canvas and screenshots.
- **src/flows.ts** is imported by both the worker and the canvas (web/canvas.ts), so it must stay environment-neutral: no DOM globals, no node-html-parser. It works against a minimal `LinkNode`/`LinkRoot` shape.
- **src/ids.ts**: all ids are random a-z0-9 (file 14, frame 8, element 6, lock 20). File ids are the only access control (capability URLs, no auth yet). `parseLink()` accepts full links, bare ids and `#a,b,c` multi-element fragments.
- **src/analytics.ts** writes Workers Analytics Engine events. File ids are hashed and frame HTML is never recorded; keep it that way.
- **web/** is the canvas client (plain TS, no framework), bundled to `public/js`. canvas.ts is the bulk of it: frame iframes, element picking, flows overlay, devices (web/devices.ts), and the phone layout under 820px with its dock. `public/canvas.html` and `public/app.css` hold markup and styles.

## Conventions and constraints

- Frames never run script. The render route's CSP (`script-src 'none'`) is what enforces this; the canvas iframes need `allow-scripts` only for Safari, so don't loosen the CSP.
- New canvas features get a keyboard shortcut and a visible `<kbd>` hint on their control (see the toolbar buttons in public/canvas.html), and the README's "Canvas keys" section is updated to match. Touch/phone equivalents go in the dock or pick bar.
- Device chrome (bezels, status bar, Dynamic Island) is drawn in CSS; don't add Apple bezel images (license).
- Not built yet: auth, comments, pasted images (R2), an MCP screenshot tool for the agent (src/screenshot.ts already renders), frame reordering.
