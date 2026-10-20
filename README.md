# Divs & Spans

Visual markdown for UI. An LLM writes HTML and CSS over MCP, the canvas renders it live, and you point at things with links: a file, a frame, or any single element.

No design tooling on purpose. No layers, shapes, or pen. The canvas renders and links; the model designs.

## Run it

```sh
npm install
npm run dev          # http://localhost:8787  ·  MCP at http://localhost:8787/mcp
npm run smoke        # in a second terminal: drives the MCP server end to end
```

Deploy to Cloudflare:

```sh
npx wrangler login
npm run deploy       # prints https://divs-and-spans.<you>.workers.dev
```

Then in Claude: **Settings → Connectors → Add custom connector** → `https://divs-and-spans.<you>.workers.dev/mcp`. Paste a file link into a chat with a task.

Claude.ai connectors call your server from the cloud, so they need the deployed URL (or a tunnel: `cloudflared tunnel --url http://localhost:8787`). Claude Code can use localhost directly:

```sh
claude mcp add --transport http divs-and-spans http://localhost:8787/mcp
```

## How it fits together

```
MCP client ──► /mcp (stateless Streamable HTTP, src/mcp.ts)
                   │
Canvas (web/) ──► /api/files/:id/...  ──►  DesignFile Durable Object (src/design-file.ts)
     ▲                                       one per file · SQLite · serializes writes
     └────────── WebSocket broadcast ◄───────┘
```

- **One Durable Object per file** holds frames, `tokens.css` and claims. Every write goes through it in order, so two sessions can't trample each other.
- **Claims.** `start_frame` locks a frame for 10 minutes and the canvas shimmers with the task. `write_frame` with the lock finishes it. A second session gets a clear "in progress" error. `base_version` rejects stale overwrites.
- **Stable element ids.** On save, every element in `<body>` gets a `data-ds` id (HTMLRewriter). Existing ids are kept across rewrites, so links survive edits. Links look like `/f/<file>/<frame>#<element>`; `get_frame` resolves the fragment to that element's markup and ancestor path.
- **Flows.** Frames link to each other with plain HTML: `href="#<frame>"` or `data-to="<frame>"`, plus `/<element>` to land on one element. `get_file` returns them as a flow map, `write_frame` warns about dead links, and the canvas draws them (`src/flows.ts` is shared by the worker and the canvas).
- **tokens.css** is injected into every frame before the frame's own styles. The default is empty except for `color-scheme: light dark`; the agent fills it in after its first frame. The canvas forces a scheme with `data-theme` on `<html>` and `color-scheme` on the iframe, so `light-dark()` and `prefers-color-scheme` both work.
- **Lint is consistency, not taste.** `write_frame` warns about colors and fonts that aren't in tokens.css, a single color scheme, or frames that use no tokens. It never comments on layout or style.
- **Frames are static.** Frames are agent-written HTML on our origin, so the render route sends `script-src 'none'`, which is what keeps them script-free. The canvas iframes are `sandbox="allow-same-origin allow-scripts"` only because Safari won't fire the canvas's own listeners in a script-less sandbox. The canvas reads the frame DOM for picking and sizing.

## MCP tools

| tool | what it does |
| --- | --- |
| `create_file` | new file, returns its link |
| `get_file` | frames, tokens.css, and the foundations/styleguide frame |
| `get_frame` | one frame's HTML; with `#element`, that element's markup and path |
| `start_frame` | claim a new or existing frame; the canvas shows the working state |
| `write_frame` | save a full HTML document; returns lint warnings |
| `update_tokens` | replace tokens.css |
| `release_frame` / `delete_frame` | give up a claim / remove a frame |

The server's `instructions` (in `src/mcp.ts`, `CONTRACT`) are the only design guidance, and they're structural on purpose.

## Canvas keys

`L` select an element to copy its link (Shift-click to select more; a selected container includes everything inside it; Option-click for its parent) · `0`–`9` select a frame · `Tab`/`Shift+Tab` next/previous frame · `C` copy links to the selected elements (or the selected frame) · `Space`+drag or drag empty canvas to pan · pinch or ⌘/Ctrl+scroll to zoom · `Shift+1` fit · `Shift+0` 100% · `F` focus selected frame · `H` full height vs one screen · `P` show every link between frames (a selected element always shows its own links; with `P` on, the selected frame's links stand out; click a line to focus just that link, again to follow it; Option-click a link in a frame to follow it) · `Esc` steps back: a focused line, then selected elements, then Select and Flows, then the frame.

## Not in the MVP yet

Auth (file ids are unguessable capability URLs for now; anyone with a link can edit) · comments · pasted images (R2) · screenshots for the agent (Browser Rendering) · responsive previews beyond the width setting · frame reordering on the canvas.
