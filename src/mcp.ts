import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./index";
import { links, newFileId, parseLink } from "./ids";
import { lintFrame, resolveElement } from "./html";
import type { CommentAuthor, Thread } from "./design-file";
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

Workflow: get_file first (it returns tokens.css and the styleguide). For each frame: start_frame (claims it and shows a working state on the canvas) → write_frame with the lock. Pass that lock to every call on a frame you've claimed, including another start_frame on it. If a link contains #<id>, it points at one element (#<id>,<id>,… points at several): get_frame returns their markup, so change those elements and leave the rest alone.

Comments: people leave comment threads on elements, on spots in a frame, or on the file. get_file and get_frame list the open ones, and a link with ?c=<id> points at one thread. Read them with get_comments (it returns the pinned element's current markup). When you've addressed one, say what you changed with comment and resolve it; if it needs the person's call, reply and leave it open.`;

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


/** A short label for who's commenting, from the client's User-Agent. */
const agentName = (client: string) =>
  /claude/.test(client) ? "Claude" : /cursor/.test(client) ? "Cursor" : /codex|openai/.test(client) ? "Codex" : /gemini/.test(client) ? "Gemini" : "Agent";

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Where a pin sits, in words: the agent can't see the canvas. */
function describePin(t: Thread): string {
  if (!t.frameId) return "A note on the whole file, not pinned to a frame.";
  const x = t.x ?? 1;
  const y = t.y ?? 0;
  if (t.elementId) {
    const v = y < 0.34 ? "top" : y > 0.66 ? "bottom" : "middle";
    const h = x < 0.34 ? "left" : x > 0.66 ? "right" : "center";
    return `On the element, near its ${v === "middle" && h === "center" ? "center" : `${v}-${h}`}.`;
  }
  const sides = [y < 0 ? "above" : y > 1 ? "below" : "", x < 0 ? "to the left" : x > 1 ? "to the right" : ""].filter(Boolean);
  if (sides.length) return `Beside the frame (${sides.join(", ")}), not on any element.`;
  return `On the frame, about ${pct(x)} across and ${pct(y)} down its screen, not on any element.`;
}
const excerpt = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

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
  const agent: CommentAuthor = { id: `agent-${client.replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "unknown"}`, name: agentName(client), kind: "agent" };

  /** A thread as the agent reads it: where it's pinned, the element's markup now, and the conversation. */
  const threadOut = (fileId: string, t: Thread, frames: Map<string, { name: string; html?: string }>) => {
    const frame = t.frameId ? frames.get(t.frameId) : undefined;
    let element: unknown;
    if (t.elementId) {
      const now = frame?.html ? resolveElement(frame.html, t.elementId, 3000) : null;
      element = now ?? { id: t.elementId, gone: true, note: "This element is no longer in the frame. `was` is how it looked when the comment was made.", was: t.snapshot };
    }
    return {
      id: t.id,
      link: L.comment(fileId, t.frameId, t.id),
      status: t.status,
      ...(t.status === "resolved" ? { resolved_by: t.resolvedBy, resolved_at: new Date(t.resolvedAt ?? 0).toISOString() } : {}),
      frame: t.frameId ? (frame ? { id: t.frameId, name: frame.name, link: L.frame(fileId, t.frameId) } : { id: t.frameId, deleted: true }) : null,
      ...(element ? { element } : {}),
      where: describePin(t),
      ...(t.view ? { seen_on: `${t.view.device}, ${t.view.w}×${t.view.h}, ${t.view.theme}` } : {}),
      comments: t.comments.map((c) => ({
        by: c.authorName,
        ...(c.authorKind === "agent" ? { agent: true } : {}),
        at: new Date(c.createdAt).toISOString(),
        text: c.body,
        ...(c.editedAt ? { edited: true } : {}),
      })),
    };
  };
  /** One line per open thread, for get_file and get_frame. */
  const threadBrief = (fileId: string, t: Thread, frameName?: string) => ({
    link: L.comment(fileId, t.frameId, t.id),
    ...(frameName ? { frame: frameName } : {}),
    ...(t.elementId ? { element: t.elementId } : {}),
    by: t.comments[0]?.authorName,
    text: excerpt(t.comments[0]?.body ?? ""),
    ...(t.comments.length > 1 ? { replies: t.comments.length - 1 } : {}),
  });

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
      const open = await stub.listThreads({ status: "open" });
      const names = new Map(state.frames.map((f) => [f.id, f.name]));
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
        ...(open.length
          ? {
              open_comments: {
                count: open.length,
                threads: open.slice(0, 20).map((t) => threadBrief(fileId, t, t.frameId ? names.get(t.frameId) ?? "(deleted frame)" : "(whole file)")),
                next: "get_comments with the file link (or a comment link) for the pinned markup and full threads.",
              },
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "get_frame",
    {
      title: "Get frame",
      description:
        "Read one frame's HTML and version. If the link ends in #<element>, also returns that element's markup and ancestor path — that's what the person is pointing at. #<element>,<element>,… returns `elements`, one per id. Lists the frame's open comments.",
      inputSchema: { link: z.string().describe("Frame link, optionally with #element or #element,element,…") },
      annotations: { readOnlyHint: true },
    },
    wrap("get_frame", async ({ link }: { link: string }, ev) => {
      const { fileId, frameId, elementIds = [] } = parse(link);
      if (!frameId) throw new Error("That's a file link. Use get_file, or pass a frame link.");
      // the person pointed at something on the canvas and pasted the link back: the core loop
      if (elementIds.length) ev.detail = "element";
      const stub = stubFor(fileId);
      const frame = await stub.getFrame(frameId);
      const open = await stub.listThreads({ frameId, status: "open" });
      const resolve = (id: string) =>
        resolveElement(frame.html, id) ?? `Element ${id} no longer exists in this frame (it may have been removed in a later version).`;
      return text({
        frame: { id: frame.id, name: frame.name, link: L.frame(fileId, frame.id), version: frame.version, status: frame.status, width: frame.width },
        ...(elementIds.length === 1 ? { element: resolve(elementIds[0]) } : {}),
        ...(elementIds.length > 1 ? { elements: elementIds.map(resolve) } : {}),
        ...(open.length ? { open_comments: open.map((t) => threadBrief(fileId, t)) } : {}),
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
      const open = frameId ? await stub.listThreads({ frameId, status: "open" }) : [];
      const warnings = [
        ...open
          .filter((t) => t.elementId && !result.html.includes(`data-ds="${t.elementId}"`))
          .map((t) => `This write removed element ${t.elementId}, which has an open comment (${L.comment(fileId, t.frameId, t.id)}): "${excerpt(t.comments[0]?.body ?? "", 100)}". If that was the fix, reply and resolve it with comment; otherwise keep the element's data-ds.`),
        ...lintFrame(result.html, tokens.css, { pinned: !!result.frame.width }),
        ...dead
          .filter((d) => d.frame === result.frame.id)
          .map((d) => `Dead link${d.text ? ` "${d.text}"` : ""} (${d.link}): ${d.reason}. Point it at a frame id from get_file, or fix it once the target frame exists.`),
      ];
      ev.warnings = warnings.length;
      return text({
        saved: { frame_link: L.frame(fileId, result.frame.id), name: result.frame.name, version: result.frame.version, elements: result.elementCount },
        warnings: warnings.length ? warnings : "none",
        ...(open.length ? { open_comments: `${open.length} open on this frame. Reply to and resolve the ones this change addresses (get_comments, comment).` } : {}),
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

  server.registerTool(
    "get_comments",
    {
      title: "Get comments",
      description:
        "Read comment threads people left on the canvas. A comment link (…?c=<id>) returns that thread; a file, frame or element link returns the threads in it. Each thread says what it's pinned to, with the element's current markup and ancestor path (or how it looked, if it has since been removed), where the pin sits, the device and theme the person was viewing, and every reply.",
      inputSchema: {
        link: z.string().describe("Comment, file, frame or element link"),
        status: z.enum(["open", "resolved", "all"]).optional().describe("Which threads to list for a file or frame link. Default open"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("get_comments", async ({ link, status = "open" }: { link: string; status?: "open" | "resolved" | "all" }, ev) => {
      const { fileId, frameId, elementIds = [], commentId } = parse(link);
      const stub = stubFor(fileId);
      let threads: Thread[];
      if (commentId) {
        ev.detail = "thread";
        threads = [await stub.getThread(commentId)];
      } else {
        threads = await stub.listThreads({ frameId, status: status === "all" ? undefined : status });
        if (elementIds.length) threads = threads.filter((t) => t.elementId && elementIds.includes(t.elementId));
        ev.detail = elementIds.length ? "element" : frameId ? "frame" : "file";
      }
      ev.size = threads.length;
      const state = await stub.getState();
      const frames = new Map<string, { name: string; html?: string }>(state.frames.map((f) => [f.id, { name: f.name }]));
      for (const id of new Set(threads.filter((t) => t.elementId && t.frameId && frames.has(t.frameId)).map((t) => t.frameId!))) {
        frames.get(id)!.html = (await stub.getFrame(id)).html;
      }
      if (!threads.length) return text(`No ${status === "all" ? "" : `${status} `}comments ${elementIds.length ? "on that element" : frameId ? "on this frame" : "in this file"}.`);
      return text({ count: threads.length, threads: threads.map((t) => threadOut(fileId, t, frames)) });
    }),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment",
      description:
        "Reply to, resolve or start a comment thread; it shows up live on the canvas. With a comment link (…?c=<id>): text replies, resolve: true resolves (false reopens); pass both to say what you changed and close it. With a frame or element link: starts a new thread pinned there, e.g. to ask the person a question. A file link starts a note on the whole file.",
      inputSchema: {
        link: z.string().describe("Comment link to reply or resolve; frame, element or file link to start a thread"),
        text: z.string().max(4000).optional().describe("The comment. Plain text"),
        resolve: z.boolean().optional().describe("Comment links only: true resolves the thread, false reopens it"),
      },
    },
    wrap("comment", async ({ link, text: body, resolve }: { link: string; text?: string; resolve?: boolean }, ev) => {
      const { fileId, frameId, elementId, commentId } = parse(link);
      const stub = stubFor(fileId);
      if (commentId) {
        if (!body?.trim() && resolve === undefined) throw new Error("Pass text to reply, resolve to resolve or reopen, or both.");
        let thread = body?.trim() ? await stub.reply(commentId, body, agent) : await stub.getThread(commentId);
        if (resolve !== undefined) thread = await stub.setThreadStatus(commentId, resolve ? "resolved" : "open", agent.name);
        ev.detail = body?.trim() ? (resolve ? "reply_resolve" : "reply") : resolve ? "resolve" : "reopen";
        return text({ comment_link: L.comment(fileId, thread.frameId, thread.id), status: thread.status, replies: thread.comments.length - 1 });
      }
      if (!body?.trim()) throw new Error("Pass text to start a thread.");
      if (resolve !== undefined) throw new Error("resolve only applies to a comment link (…?c=<id>).");
      ev.detail = elementId ? "new_element" : frameId ? "new_frame" : "new_file";
      const thread = await stub.createThread({ frameId, elementId, body, author: agent });
      return text({ comment_link: L.comment(fileId, thread.frameId, thread.id), status: thread.status });
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
