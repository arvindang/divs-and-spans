import { DesignFile, type CommentAuthor } from "./design-file";
import { handleMcp } from "./mcp";
import { newFileId } from "./ids";
import { renderForCanvas } from "./html";
import { buildExport } from "./export";
import { countryOf, track } from "./analytics";

export { DesignFile };

export interface Env {
  DESIGN_FILES: DurableObjectNamespace<DesignFile>;
  ASSETS: Fetcher;
  EVENTS?: AnalyticsEngineDataset;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/**
 * Frames are agent-authored HTML served from our own origin, so they must
 * never run script. This CSP is what enforces that, on the canvas too: the
 * canvas iframes allow scripts (Safari won't fire the canvas's own listeners
 * in a script-less sandbox), so script-src 'none' is the only thing stopping
 * frame scripts there.
 */
const FRAME_CSP = "default-src * data: blob: 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * File links are the only access control, so keep them out of search indexes
 * and out of Referer headers. The WebSocket upgrade (101) passes through as is.
 */
const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await route(request, env, ctx);
    const path = new URL(request.url).pathname;
    if (res.status === 101 || !(path.startsWith("/f/") || path.startsWith("/api/") || path.startsWith("/e/"))) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // 308 keeps the method and body, so MCP POSTs to www survive the redirect
  if (url.hostname === "www.divsandspans.com") {
    url.hostname = "divsandspans.com";
    return Response.redirect(url.toString(), 308);
  }

  if (path === "/mcp" || path.startsWith("/mcp/")) return handleMcp(request, env, ctx);

  // Canvas page for /f/<file> and /f/<file>/<frame>
  if (/^\/f\/[a-z0-9]+(\/[a-z0-9]+)?\/?$/.test(path)) {
    return env.ASSETS.fetch(new Request(new URL("/canvas", url), request));
  }

  const stub = (fileId: string) => env.DESIGN_FILES.get(env.DESIGN_FILES.idFromName(fileId));

  try {
    if (path === "/oembed") return oembed(url);

    // embeds: /e/<object id>/<key>. The Durable Object's own id finds the file without revealing its file id.
    let e = path.match(/^\/e\/([0-9a-f]{64})\/([a-z0-9]{16})(?:\/(state|tokens\.css|ws|frames\/([a-z0-9]+)))?\/?$/);
    if (e) {
      const [, objectId, key, sub, frameId] = e;
      let s: DurableObjectStub<DesignFile>;
      try {
        s = env.DESIGN_FILES.get(env.DESIGN_FILES.idFromString(objectId));
      } catch {
        throw new Error("Embed not found.");
      }
      const base = `/e/${objectId}/${key}`;
      if (!sub) return embedPage(request, env, ctx, s, key, url);
      if (sub === "state") {
        const { fileId: _, ...state } = await s.getEmbedState(key);
        return json(state);
      }
      if (sub === "tokens.css") {
        const { css } = await s.getEmbedTokens(key);
        return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" } });
      }
      if (sub === "ws") {
        const forward = new Request(`${url.origin}/ws?embed=${key}`, request);
        return s.fetch(forward);
      }
      const { html, tokensVersion } = await s.getEmbedFrame(key, frameId);
      return renderFrame(html, `${base}/tokens.css?v=${tokensVersion}`, url);
    }

    if (path === "/api/files" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      const id = newFileId();
      const state = await stub(id).init(id, (body.name || "Untitled").slice(0, 120));
      ctx.waitUntil(track(env, { event: "create", name: "web", fileId: id, country: countryOf(request) }));
      return json({ ...state, link: `${url.origin}/f/${id}` }, 201);
    }

    let m = path.match(/^\/api\/files\/([a-z0-9]+)$/);
    if (m) {
      const s = stub(m[1]);
      if (request.method === "PATCH") {
        const body = (await request.json()) as { name?: string };
        if (body.name) await s.renameFile(body.name.slice(0, 120));
      }
      if (request.method === "DELETE") {
        const trashed = await s.deleteFile();
        ctx.waitUntil(track(env, { event: "trash", name: "file-delete", fileId: m[1], country: countryOf(request) }));
        return json({ deleted: true, ...trashed });
      }
      if (!(await s.exists())) return json({ error: "not_found" }, 404);
      const trashed = await s.trashInfo();
      if (trashed) return json({ deleted: true, ...trashed }, 410);
      return json(await s.getState());
    }

    // the trash: anyone with the link can delete, so anyone with the link can restore
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/restore$/);
    if (m && request.method === "POST") {
      const state = await stub(m[1]).restoreFile();
      ctx.waitUntil(track(env, { event: "trash", name: "file-restore", fileId: m[1], country: countryOf(request) }));
      return json(state);
    }
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/trash$/);
    if (m) return json({ frames: await stub(m[1]).listTrash() });
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/frames\/([a-z0-9]+)(\/restore)?$/);
    if (m && (request.method === "DELETE" || (request.method === "POST" && m[3]))) {
      const [, fileId, frameId, restore] = m;
      const s = stub(fileId);
      const result = restore ? await s.restoreFrame(frameId) : (await s.deleteFrame(frameId, undefined, true), { deleted: true });
      ctx.waitUntil(track(env, { event: "trash", name: restore ? "frame-restore" : "frame-delete", fileId, country: countryOf(request) }));
      return json(result);
    }

    m = path.match(/^\/api\/files\/([a-z0-9]+)\/ws$/);
    if (m) {
      const forward = new Request(request);
      forward.headers.set("x-ds-country", countryOf(request));
      return stub(m[1]).fetch(forward);
    }

    // comments: people on the canvas. The agent's side is the get_comments and comment MCP tools.
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/comments(?:\/([a-z0-9]+))?(?:\/([a-z0-9]+))?$/);
    if (m) {
      const [, fileId, threadId, commentId] = m;
      const s = stub(fileId);
      if (request.method === "GET" && !threadId) return json({ threads: await s.listThreads() });
      if (request.method === "GET") return json(await s.getThread(threadId));
      const body = (await request.json().catch(() => ({}))) as {
        frameId?: string; elementId?: string; x?: number; y?: number; view?: any;
        body?: string; author?: { id?: string; name?: string; secret?: string }; status?: string; by?: string; secret?: string; viewer?: string;
      };
      const author = { id: body.author?.id ?? "", name: body.author?.name ?? "", secret: body.author?.secret, kind: "person" } as CommentAuthor;
      const note = (action: string) =>
        ctx.waitUntil(track(env, { event: "comment", name: action, fileId, actor: /^[a-z0-9]{16}$/.test(body.viewer ?? "") ? body.viewer : "", detail: "person", country: countryOf(request) }));
      if (request.method === "POST" && !threadId) {
        const thread = await s.createThread({ ...body, body: body.body ?? "", author });
        note("create");
        return json(thread, 201);
      }
      if (request.method === "POST" && !commentId) {
        const thread = await s.reply(threadId, body.body ?? "", author);
        note("reply");
        return json(thread, 201);
      }
      if (request.method === "PATCH" && !commentId) {
        const status = body.status === "resolved" ? "resolved" : "open";
        const thread = await s.setThreadStatus(threadId, status, body.by ?? "");
        note(status === "resolved" ? "resolve" : "reopen");
        return json(thread);
      }
      if (request.method === "PATCH" && commentId) {
        const thread = await s.editComment(threadId, commentId, body.body ?? "", body.secret);
        note("edit");
        return json(thread);
      }
      if (request.method === "DELETE" && commentId) {
        const thread = await s.deleteComment(threadId, commentId, body.secret);
        note("delete");
        return json({ thread });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // the file's embed (/embeds) or a frame's (/embeds/<frame>): GET reads it, POST makes it (or returns the one it has), DELETE turns it off
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/embeds(?:\/([a-z0-9]+))?$/);
    if (m) {
      const fileId = m[1];
      const frameId = m[2] ?? null;
      const s = stub(fileId);
      // path too: the canvas builds the link from its own origin (wrangler dev sees the custom domain here)
      const link = (key: string | null) => {
        const path = key ? `/e/${env.DESIGN_FILES.idFromName(fileId)}/${key}` : null;
        return { url: path && `${url.origin}${path}`, path };
      };
      if (request.method === "GET") return json(link(await s.getEmbed(frameId)));
      const note = (name: string) => ctx.waitUntil(track(env, { event: "embed", name, fileId, detail: frameId ? "frame" : "file", country: countryOf(request) }));
      if (request.method === "POST") {
        const had = await s.getEmbed(frameId);
        const key = had ?? (await s.createEmbed(frameId));
        if (!had) note("create");
        return json(link(key), had ? 200 : 201);
      }
      if (request.method === "DELETE") {
        await s.revokeEmbed(frameId);
        note("revoke");
        return json(link(null));
      }
      return json({ error: "Method not allowed" }, 405);
    }

    m = path.match(/^\/api\/files\/([a-z0-9]+)\/tokens\.css$/);
    if (m) {
      const { css } = await stub(m[1]).getTokens();
      return new Response(css, {
        headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    m = path.match(/^\/api\/files\/([a-z0-9]+)\/export\.zip$/);
    if (m) {
      const data = await stub(m[1]).getExport();
      const { zip, filename } = await buildExport({ origin: url.origin, ...data });
      ctx.waitUntil(track(env, { event: "export", name: "canvas", fileId: data.id, detail: String(data.frames.length), country: countryOf(request), size: zip.byteLength }));
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // /f/<file>/<frame>/view is the shareable alias for render
    m = path.match(/^\/api\/files\/([a-z0-9]+)\/frames\/([a-z0-9]+)\/(render|source)$/) ?? path.match(/^\/f\/([a-z0-9]+)\/([a-z0-9]+)\/(view)$/);
    if (m) {
      const [, fileId, frameId, kind] = m;
      const s = stub(fileId);
      const frame = await s.getFrame(frameId);
      if (kind === "source") {
        return new Response(frame.html, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const { version } = await s.getTokens();
      return renderFrame(frame.html, `/api/files/${fileId}/tokens.css?v=${version}`, url);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, /not found|invalid/i.test(message) ? 404 : /was deleted/i.test(message) ? 410 : /another browser/i.test(message) ? 403 : 400);
  }

  return env.ASSETS.fetch(request);
}

function renderFrame(html: string, tokensHref: string, url: URL) {
  const themeParam = url.searchParams.get("theme");
  const theme = themeParam === "light" || themeParam === "dark" ? themeParam : undefined;
  return renderForCanvas(html || "<!doctype html><html><head></head><body></body></html>", { tokensHref, theme }).then(
    (out) =>
      new Response(out, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": FRAME_CSP,
          "Cache-Control": "no-cache",
        },
      }),
  );
}

const attr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The embed player page, titled after the frame, with oEmbed discovery so Notion and Confluence unfurl it as a live embed. */
async function embedPage(request: Request, env: Env, ctx: ExecutionContext, s: DurableObjectStub<DesignFile>, key: string, url: URL) {
  let title = "Divs & Spans";
  try {
    const state = await s.getEmbedState(key);
    title = state.scope === "file" ? state.name : `${state.startName} · ${state.name}`;
    ctx.waitUntil(track(env, { event: "embed", name: "view", fileId: state.fileId, detail: url.searchParams.get("device") ?? "", country: countryOf(request) }));
  } catch {} // the player explains a missing or deleted embed itself
  const page = await env.ASSETS.fetch(new Request(new URL("/embed", url), request));
  const oembedHref = `${url.origin}/oembed?format=json&url=${encodeURIComponent(url.href)}`;
  const out = new HTMLRewriter()
    .on("title", { element: (el) => void el.setInnerContent(title) })
    .on("head", {
      element: (el) =>
        void el.append(
          `<meta property="og:title" content="${attr(title)}"><link rel="alternate" type="application/json+oembed" href="${attr(oembedHref)}" title="${attr(title)}">`,
          { html: true },
        ),
    })
    .transform(page);
  const res = new Response(out.body, out);
  res.headers.set("Cache-Control", "no-cache");
  return res;
}

/** oEmbed (https://oembed.com) for embed links: a sized iframe of the player. */
function oembed(url: URL): Response {
  const target = url.searchParams.get("url") ?? "";
  let page: URL;
  try {
    page = new URL(target);
  } catch {
    return json({ error: "Not an embed link." }, 404);
  }
  if (!/^\/e\/[0-9a-f]{64}\/[a-z0-9]{16}\/?$/.test(page.pathname)) return json({ error: "Not an embed link." }, 404);
  if (url.searchParams.get("format") && url.searchParams.get("format") !== "json") return json({ error: "Only JSON." }, 501);
  const src = `${url.origin}${page.pathname}${page.search}`;
  const desktop = /^(laptop|desktop)$/.test(page.searchParams.get("device") ?? "");
  const maxW = Number(url.searchParams.get("maxwidth")) || Infinity;
  const maxH = Number(url.searchParams.get("maxheight")) || Infinity;
  const width = Math.min(maxW, 720);
  const height = Math.min(maxH, desktop ? Math.round(width * 0.625) + 52 : 720);
  return new Response(
    JSON.stringify({
      version: "1.0",
      type: "rich",
      provider_name: "Divs & Spans",
      provider_url: url.origin,
      title: "Divs & Spans design",
      width,
      height,
      html: `<iframe src="${attr(src)}" width="${width}" height="${height}" style="border:0;max-width:100%" loading="lazy" allowfullscreen></iframe>`,
    }),
    { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
  );
}
