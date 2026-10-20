import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./index";
import { links, newFileId, parseLink } from "./ids";
import { lintFrame, resolveElement } from "./html";

/**
 * The whole contract is structural. It says nothing about aesthetics,
 * layout or which CSS features to use — the canvas shouldn't steer the design.
 */
export const CONTRACT = `Divs & Spans is a design canvas. You design UI by writing HTML and CSS; the person reviews it live on the canvas and sends you links to whole files, single frames, or individual elements.

The contract (structural only, the design itself is yours):
1. A frame is one complete HTML document (one screen, state or component sheet). Plain HTML and CSS — no frameworks, no CDNs for CSS libraries. Scripts don't run on the canvas. The canvas shows each frame one device viewport tall with the document scrolling inside (like a browser), or expanded to full page height.
2. Each file has one tokens.css that's injected into every frame before the frame's own styles. Colors, type and spacing belong there as custom properties, and frames use them via var(--…).
3. tokens.css defines both color schemes. Prefer \`color-scheme: light dark\` on :root with light-dark(<light>, <dark>) values; the canvas can force either scheme with [data-theme="light"|"dark"] on <html>.
4. On a new file, design the first frame freely, then extract what you used into tokens.css (update_tokens) and write a foundations/styleguide frame that documents palette, type, voice and rules. Later frames follow it.
5. Every element gets a stable data-ds id when saved. Keep existing data-ds attributes when you rewrite a frame so the person's links keep working.
6. Link screens with real links: href="#<frame_id>" on an <a>, or data-to="<frame_id>" on anything else (e.g. a <button>). Add /<element_id> to land on one element in that frame. The canvas draws these as the flow between frames, and get_file returns them as \`flows\`.

Workflow: get_file first (it returns tokens.css and the styleguide). For each frame: start_frame (claims it and shows a working state on the canvas) → write_frame with the lock. If a link contains #<id>, it points at one element (#<id>,<id>,… points at several): get_frame returns their markup, so change those elements and leave the rest alone.`;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function buildServer(env: Env, origin: string) {
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
    <A,>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    };

  server.registerTool(
    "create_file",
    {
      title: "Create design file",
      description: "Create a new, empty design file and return its link. Share the link with the person so they can watch the canvas.",
      inputSchema: { name: z.string().min(1).max(120).describe("Human name for the file, e.g. 'Checkout redesign'") },
    },
    wrap(async ({ name }: { name: string }) => {
      const id = newFileId();
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
    wrap(async ({ link }: { link: string }) => {
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
    wrap(async ({ link }: { link: string }) => {
      const { fileId, frameId, elementIds = [] } = parse(link);
      if (!frameId) throw new Error("That's a file link. Use get_file, or pass a frame link.");
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
        "Claim a frame before designing it. Omit frame to create a new one (name required). The canvas shows a working state with your task until you call write_frame with the returned lock. Claims expire after 10 minutes.",
      inputSchema: {
        link: z.string().describe("File link (new frame) or frame link (edit existing)"),
        name: z.string().max(120).optional().describe("Frame name, e.g. '01 Home — empty state'"),
        task: z.string().max(200).describe("Short description of what you're doing, shown on the canvas"),
        width: z.number().int().min(240).max(3840).optional().describe("Viewport width in px if this frame targets a specific device; omit to use the canvas setting"),
      },
    },
    wrap(async (a: { link: string; name?: string; task: string; width?: number }) => {
      const { fileId, frameId } = parse(a.link);
      const { frame, lock } = await stubFor(fileId).startFrame({ frameId, name: a.name, task: a.task, width: a.width });
      return text({ frame_link: L.frame(fileId, frame.id), frame_id: frame.id, lock, base_version: frame.version });
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
        lock: z.string().optional().describe("Lock token from start_frame"),
        name: z.string().max(120).optional().describe("Required when creating; renames when updating"),
        base_version: z.number().int().optional().describe("Version you edited; rejects the write if someone saved since"),
        width: z.number().int().min(240).max(3840).optional(),
      },
    },
    wrap(async (a: { link: string; html: string; lock?: string; name?: string; base_version?: number; width?: number }) => {
      const { fileId, frameId } = parse(a.link);
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
        ...lintFrame(result.html, tokens.css),
        ...dead
          .filter((d) => d.frame === result.frame.id)
          .map((d) => `Dead link${d.text ? ` "${d.text}"` : ""} (${d.link}): ${d.reason}. Point it at a frame id from get_file, or fix it once the target frame exists.`),
      ];
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
    wrap(async ({ link, css }: { link: string; css: string }) => {
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
    wrap(async ({ link, lock }: { link: string; lock: string }) => {
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
      inputSchema: { link: z.string() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ link }: { link: string }) => {
      const { fileId, frameId } = parse(link);
      if (!frameId) throw new Error("Pass a frame link.");
      await stubFor(fileId).deleteFrame(frameId);
      return text("Deleted.");
    }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. State lives in the Durable Objects. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (request.method === "GET" || request.method === "DELETE") {
    // no server-initiated stream in stateless mode
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const server = buildServer(env, origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
