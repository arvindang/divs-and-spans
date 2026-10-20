// End-to-end check through a real MCP client: node scripts/smoke.mjs [baseUrl]
// Plays the agent: creates a file, claims and writes frames, extracts tokens,
// follows an element link, and checks locks and version conflicts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { strFromU8, unzipSync } from "fflate";

const base = process.argv[2] || "http://localhost:8787";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const call = async (name, args, expectError = false) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (!!res.isError !== expectError) throw new Error(`${name} ${expectError ? "should have failed" : "failed"}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(`✗ ${msg}`);
  console.log(`✓ ${msg}`);
};

const { tools } = await client.listTools();
ok(tools.length === 8, `lists ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
ok((client.getInstructions() || "").includes("tokens.css"), "server instructions carry the contract");

const { file_link } = await call("create_file", { name: "Tidal Nocturne" });
ok(/\/f\/[a-z0-9]{14}$/.test(file_link), `created ${file_link}`);

const first = await call("get_file", { link: file_link });
ok(first.frames.length === 0 && first.tokens_css.includes("color-scheme"), "empty file has default tokens");

// 1. first frame, designed freely (hardcoded colors on purpose)
const claim = await call("start_frame", { link: file_link, name: "01 Today", task: "Designing the daily field screen" });
ok(claim.lock && claim.frame_link, "start_frame returns a lock");
const state = await (await fetch(`${base}/api/files/${file_link.split("/").pop()}`)).json();
ok(state.frames[0].status === "working", "canvas sees the frame as working");

await call("write_frame", { link: claim.frame_link, html: "<p>hi</p>" }, true);
console.log("✓ write without the lock is rejected");

const todayHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Today</title>
<style>
  body { margin: 0; font-family: var(--font-body); background: var(--surface); color: var(--text); }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 72px 48px; display: grid; gap: 48px; }
  .eyebrow { font: 500 13px/1 var(--font-mono); letter-spacing: .18em; text-transform: uppercase; color: var(--glow); }
  h1 { font: 400 clamp(48px, 6vw, 84px)/1.02 var(--font-display); margin: 12px 0 0; letter-spacing: -0.01em; }
  .lede { font: 400 22px/1.6 var(--font-display); color: var(--muted); max-width: 46ch; margin: 0; }
  .field { height: 280px; border-radius: 28px; background:
      radial-gradient(60% 80% at 30% 40%, color-mix(in oklab, var(--glow) 45%, transparent), transparent 70%),
      radial-gradient(50% 70% at 75% 60%, color-mix(in oklab, var(--warmth) 35%, transparent), transparent 70%),
      var(--horizon); }
  .areas { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .area { border: 1px solid var(--line); border-radius: 18px; padding: 22px; display: grid; gap: 10px; background: var(--raised); }
  .area b { font: 500 12px var(--font-mono); color: var(--glow); letter-spacing: .1em; }
  .area h3 { margin: 0; font: 400 26px/1.15 var(--font-display); }
  .area p { margin: 0; color: var(--muted); line-height: 1.5; }
  .row { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--line); padding-top: 24px; }
  .btn { background: var(--glow); color: var(--on-glow); border: 0; border-radius: 999px; padding: 14px 22px; font: 600 15px var(--font-body); }
  .note { color: #7a7a8c; }
</style></head><body><main class="wrap">
  <header><div class="eyebrow">Dasha.fm · Tuesday</div><h1>The tide turns inward today.</h1></header>
  <p class="lede">Moon in Shravana asks you to listen before you act. A good day for slow conversations and unfinished drafts.</p>
  <div class="field" role="img" aria-label="Today's field"></div>
  <section class="areas">
    <article class="area"><b>WORK</b><h3>Hold the draft</h3><p>Ideas need one more night. Share tomorrow.</p></article>
    <article class="area"><b>LOVE</b><h3>Ask, then listen</h3><p>A question lands better than a statement today.</p></article>
    <article class="area"><b>BODY</b><h3>Walk it off</h3><p>Evening movement settles a restless Mercury.</p></article>
  </section>
  <div class="row"><span class="note">Episode ready · 6 min</span><button class="btn">Play today's reading</button></div>
</main></body></html>`;
const w1 = await call("write_frame", { link: claim.frame_link, html: todayHtml, lock: claim.lock });
ok(w1.saved.version === 1 && w1.saved.elements > 10, `frame saved with ${w1.saved.elements} stamped elements`);
ok(String(w1.warnings).includes("no custom properties"), "lint nudges toward extracting tokens");

// 2. extract tokens, both schemes
const tokens = `:root {
  color-scheme: light dark;
  --surface: light-dark(#F6F3EC, #0D0D1A);
  --raised: light-dark(#FFFFFF, #161625);
  --horizon: light-dark(#E7E2F5, #2A2A40);
  --text: light-dark(#1B1A26, #ECEAF4);
  --muted: light-dark(#5F5C70, #A4A1B8);
  --line: light-dark(#E2DDD2, #26263A);
  --glow: light-dark(#6B4FD8, #A78BFA);
  --on-glow: light-dark(#FFFFFF, #0D0D1A);
  --warmth: light-dark(#B98A3E, #E8C794);
  --font-display: Georgia, "Times New Roman", serif;
  --font-body: -apple-system, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", Menlo, monospace;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
`;
const t = await call("update_tokens", { link: file_link, css: tokens });
ok(t.tokens_version === 2 && !t.warning, "tokens updated with both schemes");

// 3. re-save the first frame: off-system color should be flagged, ids kept
const frame1 = await call("get_frame", { link: claim.frame_link });
const ids1 = [...frame1.html.matchAll(/data-ds="([a-z0-9]+)"/g)].map((m) => m[1]);
const w2 = await call("write_frame", { link: claim.frame_link, html: frame1.html, base_version: 1 });
ok(JSON.stringify(w2.warnings).includes("#7a7a8c"), "lint flags the off-system color #7a7a8c");
const frame1b = await call("get_frame", { link: claim.frame_link });
const ids2 = [...frame1b.html.matchAll(/data-ds="([a-z0-9]+)"/g)].map((m) => m[1]);
ok(JSON.stringify(ids1) === JSON.stringify(ids2), `all ${ids1.length} element ids survive a rewrite`);

await call("write_frame", { link: claim.frame_link, html: frame1.html, base_version: 1 }, true);
console.log("✓ stale base_version is rejected");

// 4. element link → just that element
const btnId = frame1b.html.match(/<button class="btn" data-ds="([a-z0-9]+)"/)[1];
const el = await call("get_frame", { link: `${claim.frame_link}#${btnId}` });
ok(el.element.tag === "button" && el.element.outer_html.includes("Play today"), `element link resolves to <button> (${el.element.path.join(" > ")})`);

// 5. foundations frame in one step (no claim)
const swatch = (n, v) => `<div class="sw" style="background: var(${v})"><span>${n}</span><code>${v}</code></div>`;
const foundations = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: var(--surface); color: var(--text); font-family: var(--font-body); }
  .wrap { padding: 72px 48px; max-width: 1120px; margin: 0 auto; display: grid; gap: 56px; }
  .k { font: 500 13px var(--font-mono); letter-spacing: .18em; color: var(--glow); text-transform: uppercase; }
  h1 { font: 400 72px/1 var(--font-display); margin: 12px 0 0; }
  .sws { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .sw { height: 120px; border-radius: 18px; border: 1px solid var(--line); padding: 14px; display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; }
  .sw span { font: 500 12px var(--font-mono); letter-spacing: .08em; color: var(--text); }
  .sw code { font: 12px var(--font-mono); color: var(--muted); }
  .voice { font: 400 44px/1.15 var(--font-display); margin: 0; max-width: 18ch; }
  p { color: var(--muted); line-height: 1.6; max-width: 60ch; margin: 0; }
</style></head><body><main class="wrap">
  <header><div class="k">Dasha.fm · Foundations</div><h1>Tidal Nocturne</h1></header>
  <section><div class="k">01 · Palette</div><div class="sws" style="margin-top:20px">
    ${swatch("Surface", "--surface")}${swatch("Raised", "--raised")}${swatch("Horizon", "--horizon")}${swatch("Glow", "--glow")}${swatch("Warmth", "--warmth")}
  </div></section>
  <section><div class="k">02 · Voice</div><p class="voice" style="margin-top:20px">Clarity, with room to breathe.</p>
  <p style="margin-top:16px">Georgia carries meaning. It appears only where the product is interpreting, reflecting or inviting attention. Controls stay in the system sans.</p></section>
</main></body></html>`;
const f2 = await call("write_frame", { link: file_link, name: "00 Foundations", html: foundations });
ok(f2.warnings === "none", "foundations frame is fully on-system");

const final = await call("get_file", { link: file_link });
ok(final.frames.length === 2 && final.foundations.html?.includes("Tidal Nocturne"), "get_file returns the styleguide frame");

// 5b. flows: links between frames come back as a map; dead ones are flagged
const episode = `<main><a href="#${claim.frame_id}">Back to today</a><button data-to="${claim.frame_id}/${btnId}">Replay</button>
  <a href="#notes">Notes</a><section id="notes"></section><a href="#nowhere">Broken</a><a href="https://example.com">Out</a></main>`;
const f3 = await call("write_frame", { link: file_link, name: "02 Episode", html: episode });
ok(f3.warnings.some((w) => w.startsWith('Dead link "Broken"')), "write_frame flags a dead #link");
ok(f3.warnings.some((w) => w.startsWith("No media queries")) && !JSON.stringify(w2.warnings).includes("No media queries"), "lint asks fixed layouts to adapt, not ones using clamp()");
const withFlows = await call("get_file", { link: file_link });
const fromEpisode = withFlows.flows.filter((f) => f.to === claim.frame_id);
ok(fromEpisode.length === 2 && fromEpisode.some((f) => f.to_element === btnId && f.text === "Replay"), "get_file returns both flows, one landing on an element");
ok(withFlows.dead_links?.length === 1 && withFlows.dead_links[0].link === "#nowhere", "in-page anchors and external links aren't flows");

// 6. a second session can't steal a claimed frame
const c2 = await call("start_frame", { link: claim.frame_link, task: "Tightening the hero" });
await call("start_frame", { link: claim.frame_link, task: "Other session" }, true);
console.log("✓ a second session can't claim a frame that's in progress");
await call("release_frame", { link: claim.frame_link, lock: c2.lock });

const render = await fetch(`${base}/api/files/${file_link.split("/").pop()}/frames/${claim.frame_id}/render?theme=dark`);
const rhtml = await render.text();
ok(render.headers.get("content-security-policy")?.includes("script-src 'none'"), "render blocks scripts via CSP");
ok(rhtml.includes('data-theme="dark"') && rhtml.includes("tokens.css?v=2"), "render injects tokens.css and forced theme");

const exp = await fetch(`${base}/api/files/${file_link.split("/").pop()}/export.zip`);
const zip = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await exp.arrayBuffer()))).map(([k, v]) => [k.split("/").pop(), strFromU8(v)]));
ok(exp.headers.get("content-disposition")?.includes('filename="tidal-nocturne.zip"'), "export downloads as a named zip");
ok(["README.md", "index.html", "tokens.css", "01-00-foundations.html", "02-01-today.html", "03-02-episode.html"].every((n) => n in zip), "export has README, index, tokens and every frame in canvas order");
ok(zip["03-02-episode.html"].includes('href="02-01-today.html"') && zip["03-02-episode.html"].includes('href="tokens.css"'), "exported frames link tokens.css and each other");
ok(zip["README.md"].includes("| 03-02-episode.html | Replay"), "export README lists the flows");

console.log(`\nAll good. Open ${withFlows.frames[0].link}`);
await client.close();
