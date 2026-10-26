import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./index";
import { links, newFileId, parseLink } from "./ids";
import { lintFrame, resolveElement } from "./html";
import { clientFromUserAgent, countryOf, track } from "./analytics";

/**
 * The whole contract is structural. It says nothing about aesthetics,
 * layout or which CSS features to use — the canvas shouldn't steer the design.
 */
export const CONTRACT = `Divs & Spans is a design canvas. You design UI by writing HTML and CSS; the person reviews it live on the canvas and sends you links to whole files, single frames, or individual elements.

The contract (structural only, the design itself is yours):
1. A frame is one complete HTML document (one screen, state or component sheet). Plain HTML and CSS — no frameworks, no CDNs for CSS libraries. Scripts don't run on the canvas. The canvas shows each frame one device viewport tall with the document scrolling inside (like a browser), or expanded to full page height. The viewport is the iframe, so a header or tab bar that should stay put needs position: fixed or sticky, and screen-tall layouts should use vh/dvh, not a pixel device height.
2. Each file has one tokens.css that's injected into every frame before the frame's own styles. Colors, type and spacing belong there as custom properties, and frames use them via var(--…).
3. tokens.css defines both color schemes. Prefer \`color-scheme: light dark\` on :root with light-dark(<light>, <dark>) values; the canvas can force either scheme with [data-theme="light"|"dark"] on <html>.
4. On a new file, design the first frame freely, then extract what you used into tokens.css (update_tokens) and write a foundations/styleguide frame that documents palette, type, voice and rules. Later frames follow it.
5. Every element gets a stable data-ds id when saved. Keep existing data-ds attributes when you rewrite a frame so the person's links keep working.
6. Link screens with real links: href="#<frame_id>" on an <a>, or data-to="<frame_id>" on anything else (e.g. a <button>). Add /<element_id> to land on one element in that frame. The canvas draws these as the flow between frames, and get_file returns them as \`flows\`.
7. Frames are responsive by default. The person previews them on a device of their choice (iPhone 402–440 wide, iPad 744–1032, laptop 1280, desktop 1440, Android 412), so let layouts adapt with media queries, container queries or clamp(). Pass \`width\` only for a screen that exists on one kind of device (e.g. 402 for a phone-only screen); it marks the screen as device-specific and opens the file on that kind of device, but the person can still preview it at any size. Don't draw status bars, notches or home indicators: the canvas draws device chrome. Keep content clear of it with padding of var(--ds-safe-top) and var(--ds-safe-bottom), which are 0 on desktop.

Workflow: get_file first (it returns tokens.css and the styleguide). For each frame: start_frame (claims it and shows a working state on the canvas) → write_frame with the lock. Pass that lock to every call on a frame you've claimed, including another start_frame on it. If a link contains #<id>, it points at one element (#<id>,<id>,… points at several): get_frame returns their markup, so change those elements and leave the rest alone.`;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** What a tool call reports to analytics. Handlers fill in what only they know. */
interface ToolEvent {
  fileId?: string;
  detail?: string;
  size?: number;
  warnings?: number;
}

/** Errors grouped by cause, so the weekly report can tell conflicts from bad links. */
const errorKind = (message: string) =>
  /didn't pass its lock/i.test(message) ? "no_lock"
  : /being worked on|version conflict/i.test(message) ? "conflict"
  : /couldn't read|file link|pass a frame link/i.test(message) ? "bad_link"
  : /not found/i.test(message) ? "not_found"
  : "error";

function buildServer(env: Env, request: Request, ctx: ExecutionContext) {
  const origin = new URL(request.url).origin;
  const client = clientFromUserAgent(request.headers.get("User-Agent"));
  const country = countryOf(request);
  const L = links(origin);
  const server = new McpServer(
    { name: "divs-and-spans", version: "0.1.0" },
    { instructions: CONTRACT },
  );

  const stubFor = (fileId: string) => env.DESIGN_FILES.get(env.DESIGN_FILES.idFromName(fileId));
  const parse = (link: string) => {
    const p = parseLink(link);
    if (!p) throw new Error(`Couldn't read "${link}" as a Divs & Spans link. Expected ${origin}/f/<file>[/<frame>][#<element>[,<element>…]].`);
    return p;
  };
  const wrap =
    <A,>(tool: string, fn: (args: A, ev: ToolEvent) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      const started = Date.now();
      const link = (args as { link?: unknown }).link;
      const ev: ToolEvent = { fileId: typeof link === "string" ? parseLink(link)?.fileId : undefined };
      const report = (detail: string) =>
        ctx.waitUntil(track(env, { event: "tool", name: tool, actor: client, country, ms: Date.now() - started, ...ev, detail }));
      try {
        const result = await fn(args, ev);
        report(ev.detail ?? "ok");
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report(errorKind(message));
        return fail(message);
      }
    };

  server.registerTool(
    "create_file",
    {
      title: "Create design file",
      description: "Create a new, empty design file and return its link. Share the link with the person so they can watch the canvas.",
      inputSchema: { name: z.string().min(1).max(120).describe("Human name for the file, e.g. 'Checkout redesign'") },
    },
    wrap("create_file", async ({ name }: { name: string }, ev) => {
      const id = newFileId();
      ev.fileId = id;
      await stubFor(id).init(id, name);
      return text({ file_link: L.file(id), name, next: "Design the first frame freely, then extract tokens.css and a foundations frame." });
    }),
  );

  server.registerTool(
    "get_file",
    {
      title: "Get design file",
      description:
        "Read a design file: its frames, tokens.css and the styleguide/foundations frame. Call this before designing anything in a file. Accepts a file, frame or element link.",
      inputSchema: { link: z.string().describe("Any Divs & Spans link for the file") },
      annotations: { readOnlyHint: true },
    },
    wrap("get_file", async ({ link }: { link: string }) => {
      const { fileId } = parse(link);
      const stub = stubFor(fileId);
      const state = await stub.getState();
      const tokens = await stub.getTokens();
      const { flows, dead } = await stub.getFlows();
      const foundations = state.frames.find((f) => f.foundations);
      let foundationsHtml: string | null = null;
      if (foundations?.hasContent) {
        const f = await stub.getFrame(foundations.id);
        foundationsHtml = f.html.length > 24000 ? f.html.slice(0, 24000) + "\n<!-- truncated -->" : f.html;
      }
      return text({
        file: { name: state.name, link: L.file(fileId) },
        frames: state.frames.map((f) => ({
          id: f.id,
          name: f.name,
          link: L.frame(fileId, f.id),
          version: f.version,
          status: f.status,
          ...(f.task ? { working_on: f.task } : {}),
          ...(f.width ? { width: f.width } : {}),
        })),
        tokens_css: tokens.css,
        foundations: foundations
          ? { frame: foundations.name, link: L.frame(fileId, foundations.id), html: foundationsHtml }
          : "No foundations/styleguide frame yet. After the first frame, extract tokens.css and write one.",
        flows: flows.length ? flows : "No links between frames yet. See contract rule 6.",
        ...(dead.length ? { dead_links: dead } : {}),
      });
    }),
  );

  server.registerTool(
    "get_frame",
    {
      title: "Get frame",
      description:
        "Read one frame's HTML and version. If the link ends in #<element>, also returns that element's markup and ancestor path — that's what the person is pointing at. #<element>,<element>,… returns `elements`, one per id.",
      inputSchema: { link: z.string().describe("Frame link, optionally with #element or #element,element,…") },
      annotations: { readOnlyHint: true },
    },
    wrap("get_frame", async ({ link }: { link: string }, ev) => {
      const { fileId, frameId, elementIds = [] } = parse(link);
      if (!frameId) throw new Error("That's a file link. Use get_file, or pass a frame link.");
      // the person pointed at something on the canvas and pasted the link back: the core loop
      if (elementIds.length) ev.detail = "element";
      const frame = await stubFor(fileId).getFrame(frameId);
      const resolve = (id: string) =>
        resolveElement(frame.html, id) ?? `Element ${id} no longer exists in this frame (it may have been removed in a later version).`;
      return text({
        frame: { id: frame.id, name: frame.name, link: L.frame(fileId, frame.id), version: frame.version, status: frame.status, width: frame.width },
        ...(elementIds.length === 1 ? { element: resolve(elementIds[0]) } : {}),
        ...(elementIds.length > 1 ? { elements: elementIds.map(resolve) } : {}),
        html: frame.html,
      });
    }),
  );

  server.registerTool(
    "start_frame",
    {
      title: "Start frame",
      description:
        "Claim a frame before designing it. Omit frame to create a new one (name required). The canvas shows a working state with your task until you call write_frame with the returned lock. Claims expire after 10 minutes. To renew a claim you hold (more time, new task), pass its lock; without it the frame reads as taken.",
      inputSchema: {
        link: z.string().describe("File link (new frame) or frame link (edit existing)"),
        lock: z.string().optional().describe("Your lock for this frame, to renew a claim you already hold"),
        name: z.string().max(120).optional().describe("Frame name, e.g. '01 Home — empty state'"),
        task: z.string().max(200).describe("Short description of what you're doing, shown on the canvas"),
        width: z.number().int().min(240).max(3840).optional().describe("Only for a screen that exists on one kind of device: its width in px (e.g. 402 phone, 820 tablet). Omit for responsive frames. The person can preview any frame at any size."),
      },
    },
    wrap("start_frame", async (a: { link: string; lock?: string; name?: string; task: string; width?: number }, ev) => {
      const { fileId, frameId } = parse(a.link);
      ev.detail = !frameId ? "new" : a.lock ? "renew" : "edit";
      const { frame, lock } = await stubFor(fileId).startFrame({ frameId, name: a.name, task: a.task, width: a.width, lock: a.lock });
      return text({
        frame_link: L.frame(fileId, frame.id),
        frame_id: frame.id,
        lock,
        base_version: frame.version,
        next: "write_frame with this frame_link and lock. The frame stays claimed until then, and calls on it without the lock fail.",
      });
    }),
  );

  server.registerTool(
    "write_frame",
    {
      title: "Write frame",
      description:
        "Save a frame's full HTML document; it renders live on the canvas. Pass a frame link (from start_frame) plus lock to finish a claimed frame, or a file link plus name to create one in a single step. Keep existing data-ds attributes. Returns consistency warnings against tokens.css — fix them if they're unintentional.",
      inputSchema: {
        link: z.string().describe("Frame link to update, or file link to create a new frame"),
        html: z.string().min(1).describe("Complete HTML document for the frame"),
        lock: z.string().optional().describe("Lock token from start_frame. Required when you claimed the frame"),
        name: z.string().max(120).optional().describe("Required when creating; renames when updating"),
        base_version: z.number().int().optional().describe("Version you edited; rejects the write if someone saved since"),
        width: z.number().int().min(240).max(3840).optional(),
      },
    },
    wrap("write_frame", async (a: { link: string; html: string; lock?: string; name?: string; base_version?: number; width?: number }, ev) => {
      const { fileId, frameId } = parse(a.link);
      ev.detail = frameId ? "edit" : "new";
      ev.size = a.html.length;
      const stub = stubFor(fileId);
      const result = await stub.writeFrame({
        frameId,
        name: a.name,
        html: a.html,
        lock: a.lock,
        baseVersion: a.base_version,
        width: a.width,
      });
      const tokens = await stub.getTokens();
      const { dead } = await stub.getFlows();
      const warnings = [
        ...lintFrame(result.html, tokens.css, { pinned: !!result.frame.width }),
        ...dead
          .filter((d) => d.frame === result.frame.id)
          .map((d) => `Dead link${d.text ? ` "${d.text}"` : ""} (${d.link}): ${d.reason}. Point it at a frame id from get_file, or fix it once the target frame exists.`),
      ];
      ev.warnings = warnings.length;
      return text({
        saved: { frame_link: L.frame(fileId, result.frame.id), name: result.frame.name, version: result.frame.version, elements: result.elementCount },
        warnings: warnings.length ? warnings : "none",
      });
    }),
  );

  server.registerTool(
    "update_tokens",
    {
      title: "Update tokens.css",
      description:
        "Replace the file's tokens.css. Every frame re-renders with it. Define both color schemes. Send the whole stylesheet, not a diff.",
      inputSchema: {
        link: z.string().describe("Any link in the file"),
        css: z.string().min(1).describe("Full contents of tokens.css"),
      },
    },
    wrap("update_tokens", async ({ link, css }: { link: string; css: string }) => {
      const { fileId } = parse(link);
      const { version } = await stubFor(fileId).updateTokens(css);
      const both = /light-dark\(|prefers-color-scheme|\[data-theme/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ""));
      return text({ tokens_version: version, ...(both ? {} : { warning: "Only one color scheme defined." }) });
    }),
  );

  server.registerTool(
    "release_frame",
    {
      title: "Release frame",
      description: "Give up a claim from start_frame without writing. A new, empty frame is removed.",
      inputSchema: { link: z.string(), lock: z.string() },
    },
    wrap("release_frame", async ({ link, lock }: { link: string; lock: string }) => {
      const { fileId, frameId } = parse(link);
      if (!frameId) throw new Error("Pass a frame link.");
      await stubFor(fileId).releaseFrame(frameId, lock);
      return text("Released.");
    }),
  );

  server.registerTool(
    "delete_frame",
    {
      title: "Delete frame",
      description: "Delete a frame. Only do this when the person asks.",
      inputSchema: { link: z.string(), lock: z.string().optional().describe("Lock token, if you claimed the frame with start_frame") },
      annotations: { destructiveHint: true },
    },
    wrap("delete_frame", async ({ link, lock }: { link: string; lock?: string }) => {
      const { fileId, frameId } = parse(link);
      if (!frameId) throw new Error("Pass a frame link.");
      await stubFor(fileId).deleteFrame(frameId, lock);
      return text("Deleted.");
    }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. State lives in the Durable Objects. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // no server-initiated stream in stateless mode
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  // clientInfo only arrives on initialize, so that's where we learn which client connected
  ctx.waitUntil(
    request
      .clone()
      .json()
      .then((body: any) => {
        const init = (Array.isArray(body) ? body : [body]).find((m) => m?.method === "initialize");
        if (!init) return;
        const info = init.params?.clientInfo ?? {};
        return track(env, {
          event: "connect",
          name: String(info.name ?? "unknown").slice(0, 64),
          actor: clientFromUserAgent(request.headers.get("User-Agent")),
          detail: String(info.version ?? "").slice(0, 32),
          country: countryOf(request),
        });
      })
      .catch(() => {}),
  );
  const server = buildServer(env, request, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
