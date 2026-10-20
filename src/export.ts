import { parse } from "node-html-parser";
import { strToU8, zipSync } from "fflate";
import { linksIn, resolveLink } from "./flows";
import { renderForCanvas, type Flow } from "./html";
import type { FrameSummary } from "./design-file";

interface ExportInput {
  origin: string;
  id: string;
  name: string;
  tokens: string;
  frames: (FrameSummary & { html: string })[];
  flows: Flow[];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const slugify = (s: string) =>
  s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9\s_-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 48);

/** Point <a href="#frame"> links at the exported .html files so flows click through offline. data-to stays as written. */
async function rewriteFrameLinks(html: string, fileId: string, frameId: string, fileNames: Map<string, string>): Promise<string> {
  const { links, anchors } = linksIn(parse(html, { comment: false }), fileId);
  const hrefs = new Map<string, string>();
  for (const l of links) {
    if (l.el.getAttribute("data-to") != null) continue;
    const r = resolveLink(l.ref, frameId, (id) => fileNames.has(id), anchors);
    if (r?.kind === "edge") hrefs.set(l.element, fileNames.get(r.to)!);
  }
  if (!hrefs.size) return html;
  const rewriter = new HTMLRewriter().on("a[data-ds]", {
    element(el) {
      const href = hrefs.get(el.getAttribute("data-ds")!);
      if (href) el.setAttribute("href", href);
    },
  });
  return rewriter.transform(new Response(html)).text();
}

/**
 * A zip of the whole file for viewing offline or handing to another agent:
 * one .html per frame linked to tokens.css, an index.html to browse them,
 * and a README.md that explains the structure to whoever builds on it.
 */
export async function buildExport(input: ExportInput): Promise<{ zip: Uint8Array; filename: string }> {
  const folder = slugify(input.name) || input.id;
  const fileNames = new Map(
    input.frames.map((f, i) => [f.id, `${String(i + 1).padStart(2, "0")}-${slugify(f.name) || f.id}.html`]),
  );
  const fileLink = `${input.origin}/f/${input.id}`;

  const files: Record<string, Uint8Array> = {
    "tokens.css": strToU8(input.tokens),
    "index.html": strToU8(indexHtml(input, fileNames)),
    "README.md": strToU8(readme(input, fileNames, fileLink)),
  };
  for (const f of input.frames) {
    const html = await rewriteFrameLinks(f.html, input.id, f.id, fileNames);
    files[fileNames.get(f.id)!] = strToU8(await renderForCanvas(html, { tokensHref: "tokens.css" }));
  }

  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [`${folder}/${name}`, data])), { level: 6 });
  return { zip, filename: `${folder}.zip` };
}

function indexHtml(input: ExportInput, fileNames: Map<string, string>): string {
  const outgoing = (id: string) =>
    [...new Set(input.flows.filter((fl) => fl.from === id).map((fl) => fl.to))]
      .map((to) => `<a href="${fileNames.get(to)}">${escapeHtml(input.frames.find((f) => f.id === to)!.name)}</a>`)
      .join(", ");
  const rows = input.frames
    .map((f) => {
      const links = outgoing(f.id);
      return `<li><a class="name" href="${fileNames.get(f.id)}">${escapeHtml(f.name)}</a>` +
        `<span class="meta">${f.id}${f.width ? ` · ${f.width}px` : ""}${f.foundations ? " · styleguide" : ""}</span>` +
        (links ? `<span class="to">→ ${links}</span>` : "") +
        `</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.name)}</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { max-width: 720px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { color: GrayText; margin: 0 0 24px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; padding: 10px 0; border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  .name { font-weight: 600; }
  .meta, .to { color: GrayText; font-size: 13px; }
  .to { flex-basis: 100%; }
</style>
</head>
<body>
<h1>${escapeHtml(input.name)}</h1>
<p>${input.frames.length} frame${input.frames.length === 1 ? "" : "s"} · <a href="tokens.css">tokens.css</a> · <a href="README.md">README.md</a></p>
<ul>
${rows}
</ul>
</body>
</html>
`;
}

function readme(input: ExportInput, fileNames: Map<string, string>, fileLink: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  const styleguide = input.frames.find((f) => f.foundations);
  const pinned = input.frames.filter((f) => f.width);

  const frameRows = input.frames
    .map((f) => `| ${fileNames.get(f.id)} | ${cell(f.name)} | \`${f.id}\` | ${f.width ? `${f.width}px` : "responsive"} |`)
    .join("\n");
  const flowRows = input.flows
    .map((fl) => `| ${fileNames.get(fl.from)} | ${cell(fl.text)} (\`${fl.element}\`) | ${fileNames.get(fl.to)}${fl.to_element ? ` → \`${fl.to_element}\`` : ""} |`)
    .join("\n");

  return `# ${input.name}

Static HTML/CSS design for this product, exported from Divs & Spans on ${new Date().toISOString().slice(0, 10)}.
Each \`.html\` file is one frame: a complete document for one screen, state or component sheet.
Open \`index.html\` in a browser to click through them.

Live file: ${fileLink}
Anyone with that link can view and edit the design, so share it (and this README) accordingly.

## Files

- \`tokens.css\`: the design system as CSS custom properties (color, type, spacing). Every frame links it before its own styles.
- \`index.html\`: every frame with the screens it links to.
${styleguide ? `- \`${fileNames.get(styleguide.id)}\`: the styleguide (palette, type, voice, rules). Read it first.\n` : ""}
| File | Frame | Frame id | Width |
| --- | --- | --- | --- |
${frameRows || "| — | no frames yet | | |"}

## How the frames are built

- **Tokens are the source of truth.** Frames use \`var(--…)\` from \`tokens.css\`; reuse them rather than hard-coding colors or fonts.
- **Both color schemes.** \`tokens.css\` declares \`color-scheme\` and usually \`light-dark()\` values, so frames follow the system setting. \`data-theme="light"\` or \`"dark"\` on \`<html>\` forces one when the tokens support it.
- **Responsive.** Frames adapt from phone (~402px) to desktop (1440px) unless pinned to one width${pinned.length ? ` (${pinned.map((f) => `${cell(f.name)}: ${f.width}px`).join(", ")})` : ""}.
- **Safe areas.** \`--ds-safe-top\` and \`--ds-safe-bottom\` keep content clear of device chrome on the canvas and are 0 here. In an app, map them to \`env(safe-area-inset-top)\` and \`env(safe-area-inset-bottom)\`.
- **No script.** Frames are static; interactive states are drawn as separate frames.
- **Element ids.** \`data-ds="…"\` attributes are stable ids from the canvas. A link like \`${fileLink}/<frame id>#<element id>\` points at one element. Strip them in production code if you like.
- **Flows.** \`<a href>\` links between frames point at the exported files. Other elements say where they lead with \`data-to="<frame id>"\` (optionally \`/<element id>\`); wire those up in your app.

## Flows

${flowRows ? `| From | Element | To |\n| --- | --- | --- |\n${flowRows}` : "No links between frames yet."}

## Keep designing on the canvas

To change the design rather than build from it, connect an MCP client to \`${input.origin}/mcp\` (Streamable HTTP) and call \`get_file\` with the live file link above.
`.replace(/\n{3,}/g, "\n\n");
}
