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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

      m = path.match(/^\/api\/files\/([a-z0-9]+)\/frames\/([a-z0-9]+)\/(render|source)$/);
      if (m) {
        const [, fileId, frameId, kind] = m;
        const s = stub(fileId);
        const frame = await s.getFrame(frameId);
        if (kind === "source") {
          return new Response(frame.html, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const { version } = await s.getTokens();
        const themeParam = url.searchParams.get("theme");
        const theme = themeParam === "light" || themeParam === "dark" ? themeParam : undefined;
        const html = await renderForCanvas(frame.html || "<!doctype html><html><head></head><body></body></html>", {
          tokensHref: `/api/files/${fileId}/tokens.css?v=${version}`,
          theme,
        });
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": FRAME_CSP,
            "Cache-Control": "no-cache",
          },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json({ error: message }, /not found/i.test(message) ? 404 : /was deleted/i.test(message) ? 410 : /another browser/i.test(message) ? 403 : 400);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
