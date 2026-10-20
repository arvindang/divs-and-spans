import { DesignFile } from "./design-file";
import { handleMcp } from "./mcp";
import { newFileId } from "./ids";
import { renderForCanvas } from "./html";
import { buildExport, frameFileName, slugify } from "./export";
import { openShooter, parseView, viewKey, type Shooter } from "./screenshot";
import { zipSync } from "fflate";
import { countryOf, track } from "./analytics";

export { DesignFile };

export interface Env {
  DESIGN_FILES: DurableObjectNamespace<DesignFile>;
  ASSETS: Fetcher;
  BROWSER: Fetcher;
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

      m = path.match(/^\/api\/files\/([a-z0-9]+)\/frames\/([a-z0-9]+)\/png$/);
      if (m) {
        const [, fileId, frameId] = m;
        const s = stub(fileId);
        const [frame, tokens] = await Promise.all([s.getFrame(frameId), s.getTokens()]);
        if (!frame.html) return json({ error: "This frame has no content yet" }, 404);
        const view = parseView(url.searchParams);
        const elements = (url.searchParams.get("el") ?? "").split(",").filter((id) => /^[a-z0-9_-]{2,32}$/i.test(id)).slice(0, 50);
        const started = Date.now();
        let shooter: Shooter | null = null;
        try {
          const { png, scale, cached } = await cachedShot(ctx, `${fileId}/${frameId}/${frame.version}/${tokens.version}/${viewKey(view)}/${elements.join(",")}`, async () => {
            shooter = await openShooter(env.BROWSER);
            return shooter.shoot(frame.html, tokens.css, view, elements);
          });
          ctx.waitUntil(track(env, { event: "png", name: elements.length ? "element" : "frame", fileId, detail: cached ? "cached" : `${scale}x`, country: countryOf(request), ms: Date.now() - started, size: png.byteLength }));
          return new Response(png, { headers: { "Content-Type": "image/png", "X-DS-Scale": String(scale), "Cache-Control": "no-cache" } });
        } catch (e) {
          return shotError(e);
        } finally {
          await (shooter as Shooter | null)?.close();
        }
      }

      m = path.match(/^\/api\/files\/([a-z0-9]+)\/png\.zip$/);
      if (m) {
        const data = await stub(m[1]).getExport();
        const view = parseView(url.searchParams);
        const started = Date.now();
        let shooter: Shooter | null = null;
        try {
          const files: Record<string, Uint8Array> = {};
          const folder = `${slugify(data.name) || data.id}-png`;
          for (const [i, f] of data.frames.entries()) {
            const { png } = await cachedShot(ctx, `${data.id}/${f.id}/${f.version}/${data.tokensVersion}/${viewKey(view)}/`, async () => {
              shooter ??= await openShooter(env.BROWSER);
              return shooter.shoot(f.html, data.tokens, view);
            });
            files[`${folder}/${frameFileName(f, i, "png")}`] = png;
          }
          // PNGs are already compressed: store them
          const zip = zipSync(files, { level: 0 });
          ctx.waitUntil(track(env, { event: "png", name: "zip", fileId: data.id, detail: String(data.frames.length), country: countryOf(request), ms: Date.now() - started, size: zip.byteLength }));
          return new Response(zip, {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="${folder}.zip"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (e) {
          return shotError(e);
        } finally {
          await (shooter as Shooter | null)?.close();
        }
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

/**
 * A frame's PNG only changes when the frame, the tokens or the view does, and
 * all three are in the key, so a cached one never goes stale. The Cache API is
 * per data center and a no-op on workers.dev; that only costs a re-render.
 */
async function cachedShot(
  ctx: ExecutionContext,
  key: string,
  render: () => Promise<{ png: Uint8Array; scale: 1 | 2 }>,
): Promise<{ png: Uint8Array; scale: 1 | 2; cached: boolean }> {
  const req = new Request(`https://png.cache.divsandspans/${key}`);
  const hit = await caches.default.match(req);
  if (hit) return { png: new Uint8Array(await hit.arrayBuffer()), scale: hit.headers.get("X-DS-Scale") === "1" ? 1 : 2, cached: true };
  const shot = await render();
  ctx.waitUntil(caches.default.put(req, new Response(shot.png, {
    headers: { "Content-Type": "image/png", "X-DS-Scale": String(shot.scale), "Cache-Control": "public, max-age=2592000" },
  })));
  return { ...shot, cached: false };
}

function shotError(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(message)) return json({ error: message }, 404);
  console.error("png", message);
  return json({ error: `Couldn't render the image: ${message}` }, 503);
}
