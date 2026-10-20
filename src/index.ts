import { DesignFile } from "./design-file";
import { handleMcp } from "./mcp";
import { newFileId } from "./ids";
import { renderForCanvas } from "./html";
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
        if (!(await s.exists())) return json({ error: "not_found" }, 404);
        return json(await s.getState());
      }

      m = path.match(/^\/api\/files\/([a-z0-9]+)\/ws$/);
      if (m) {
        const forward = new Request(request);
        forward.headers.set("x-ds-country", countryOf(request));
        return stub(m[1]).fetch(forward);
      }

      m = path.match(/^\/api\/files\/([a-z0-9]+)\/tokens\.css$/);
      if (m) {
        const { css } = await stub(m[1]).getTokens();
        return new Response(css, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
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
      return json({ error: message }, /not found/i.test(message) ? 404 : 400);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
