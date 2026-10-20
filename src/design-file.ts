import { DurableObject } from "cloudflare:workers";
import { newFrameId, newLockToken } from "./ids";
import { flowMap, normalizeDocument, stampElementIds } from "./html";
import type { Env } from "./index";
import { track } from "./analytics";

/** How long a start_frame claim holds before another session may take the frame. */
const LOCK_MS = 10 * 60 * 1000;

/** The canvas pings every 25s; a ping marked active (visible tab, recent input) counts as that much engaged time. */
const PING_MS = 25 * 1000;

/** Kept on each socket (survives hibernation) so the session can be reported when it closes. */
interface ViewerSession {
  viewer: string;
  device: string;
  country: string;
  start: number;
  activePings: number;
}

export const DEFAULT_TOKENS = `/* tokens.css — the design system for this file.
   Empty on purpose: the first frames set the direction, then the agent
   extracts palette, type and spacing here as custom properties.
   Define both schemes, e.g. --surface: light-dark(#fff, #111); */
:root {
  color-scheme: light dark;
}
`;

export type FrameStatus = "working" | "ready";

/** The styleguide frame. It documents the system, so it always sits first on the canvas. */
export const isFoundationsName = (name: string) => /foundation|style ?guide|design system|tokens/i.test(name);

export interface FrameSummary {
  id: string;
  name: string;
  status: FrameStatus;
  task: string | null;
  version: number;
  position: number;
  foundations: boolean;
  width: number | null;
  hasContent: boolean;
  lockExpiresAt: number | null;
  updatedAt: number;
}

export interface FileState {
  id: string;
  name: string;
  createdAt: number;
  tokensVersion: number;
  frames: FrameSummary[];
}

export class ToolError extends Error {}

interface FrameRow {
  id: string;
  name: string;
  html: string;
  status: FrameStatus;
  task: string | null;
  lock: string | null;
  lock_expires: number | null;
  version: number;
  position: number;
  width: number | null;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

type Broadcast =
  | { type: "frame"; frame: FrameSummary }
  | { type: "frame-deleted"; id: string }
  | { type: "tokens"; version: number }
  | { type: "file"; name: string };

/**
 * One Durable Object per design file. It owns the file's frames and tokens,
 * serializes every write (so claims can't race), and fans changes out to
 * every open canvas over hibernatable WebSockets.
 */
export class DesignFile extends DurableObject<Env> {
  private sql: SqlStorage;
  /** False until init() runs. Lookups of a file that doesn't exist must not write, or they'd count as stored objects. */
  private ready: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private createSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        html TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        task TEXT,
        lock TEXT,
        lock_expires INTEGER,
        version INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        width INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ready = true;
  }

  // ---------- meta ----------

  private meta(key: string): string | null {
    if (!this.ready) return null;
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : null;
  }
  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  private requireFile() {
    if (!this.meta("id")) throw new ToolError("Design file not found. Check the link, or create one with create_file.");
  }

  async init(id: string, name: string): Promise<FileState> {
    if (!this.ready) this.createSchema();
    if (!this.meta("id")) {
      this.setMeta("id", id);
      this.setMeta("name", name);
      this.setMeta("created_at", String(Date.now()));
      this.setMeta("tokens", DEFAULT_TOKENS);
      this.setMeta("tokens_version", "1");
    }
    return this.getState();
  }

  async exists(): Promise<boolean> {
    return !!this.meta("id");
  }

  async getState(): Promise<FileState> {
    this.requireFile();
    return {
      id: this.meta("id")!,
      name: this.meta("name")!,
      createdAt: Number(this.meta("created_at")),
      tokensVersion: Number(this.meta("tokens_version")),
      frames: this.sql
        .exec<FrameRow>("SELECT * FROM frames ORDER BY position ASC")
        .toArray()
        .map((r) => this.summarize(r))
        .sort((a, b) => Number(b.foundations) - Number(a.foundations)),
    };
  }

  async renameFile(name: string): Promise<void> {
    this.requireFile();
    this.setMeta("name", name);
    this.broadcast({ type: "file", name });
  }

  // ---------- tokens ----------

  async getTokens(): Promise<{ css: string; version: number }> {
    this.requireFile();
    return { css: this.meta("tokens")!, version: Number(this.meta("tokens_version")) };
  }

  async updateTokens(css: string): Promise<{ version: number }> {
    this.requireFile();
    const version = Number(this.meta("tokens_version")) + 1;
    this.setMeta("tokens", css);
    this.setMeta("tokens_version", String(version));
    this.broadcast({ type: "tokens", version });
    return { version };
  }

  // ---------- frames ----------

  private row(frameId: string): FrameRow {
    const r = this.sql.exec<FrameRow>("SELECT * FROM frames WHERE id = ?", frameId).toArray()[0];
    if (!r) throw new ToolError(`Frame ${frameId} not found in this file.`);
    return r;
  }

  private summarize(r: FrameRow): FrameSummary {
    const now = Date.now();
    const lockLive = r.status === "working" && r.lock_expires !== null && r.lock_expires > now;
    return {
      id: r.id,
      name: r.name,
      // an expired claim reads as ready (or empty) so a crashed session never shimmers forever
      status: lockLive ? "working" : "ready",
      task: lockLive ? r.task : null,
      version: r.version,
      position: r.position,
      foundations: isFoundationsName(r.name),
      width: r.width,
      hasContent: r.html.length > 0,
      lockExpiresAt: lockLive ? r.lock_expires : null,
      updatedAt: r.updated_at,
    };
  }

  async getFrame(frameId: string): Promise<FrameSummary & { html: string }> {
    this.requireFile();
    const r = this.row(frameId);
    return { ...this.summarize(r), html: r.html };
  }

  async getFlows() {
    this.requireFile();
    const rows = this.sql.exec<{ id: string; html: string }>("SELECT id, html FROM frames WHERE html != ''").toArray();
    return flowMap(this.meta("id")!, rows);
  }

  /** Everything an export needs in one call: frames in canvas order with their html, tokens and flows. */
  async getExport() {
    const state = await this.getState();
    const html = new Map(
      this.sql.exec<{ id: string; html: string }>("SELECT id, html FROM frames WHERE html != ''").toArray().map((r) => [r.id, r.html]),
    );
    return {
      id: state.id,
      name: state.name,
      tokens: this.meta("tokens")!,
      frames: state.frames.filter((f) => html.has(f.id)).map((f) => ({ ...f, html: html.get(f.id)! })),
      flows: (await this.getFlows()).flows,
    };
  }

  private nextPosition(): number {
    const r = this.sql.exec<{ p: number | null }>("SELECT MAX(position) AS p FROM frames").toArray()[0];
    return (r?.p ?? -1) + 1;
  }

  private assertClaimable(r: FrameRow, lock?: string) {
    const live = r.status === "working" && r.lock_expires !== null && r.lock_expires > Date.now();
    if (live && r.lock !== lock) {
      const mins = Math.ceil((r.lock_expires! - Date.now()) / 60000);
      throw new ToolError(
        `Frame "${r.name}" is being worked on by another session${r.task ? ` (task: ${r.task})` : ""}. ` +
          `Its claim expires in ~${mins} min. Work on a different frame or try again later.`,
      );
    }
  }

  /** Claim a frame (new or existing). The canvas shows a working state until write_frame. */
  async startFrame(input: { frameId?: string; name?: string; task: string; width?: number | null }) {
    this.requireFile();
    const now = Date.now();
    const lock = newLockToken();
    let id = input.frameId;
    if (id) {
      const r = this.row(id);
      this.assertClaimable(r);
      this.sql.exec(
        "UPDATE frames SET status = 'working', task = ?, lock = ?, lock_expires = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?",
        input.task, lock, now + LOCK_MS, input.name ?? null, now, id,
      );
    } else {
      if (!input.name) throw new ToolError("A name is required to start a new frame.");
      id = newFrameId();
      this.sql.exec(
        "INSERT INTO frames (id, name, html, status, task, lock, lock_expires, version, position, width, created_at, updated_at) VALUES (?, ?, '', 'working', ?, ?, ?, 0, ?, ?, ?, ?)",
        id, input.name, input.task, lock, now + LOCK_MS, this.nextPosition(), input.width ?? null, now, now,
      );
    }
    const frame = this.summarize(this.row(id));
    this.broadcast({ type: "frame", frame });
    return { frame, lock };
  }

  /** Save a frame. Creates one when frameId is omitted. */
  async writeFrame(input: {
    frameId?: string;
    name?: string;
    html: string;
    lock?: string;
    baseVersion?: number;
    width?: number | null;
  }) {
    this.requireFile();
    const now = Date.now();
    const doc = normalizeDocument(input.html);
    let id = input.frameId;

    if (id) {
      const r = this.row(id);
      this.assertClaimable(r, input.lock);
      if (input.baseVersion !== undefined && input.baseVersion !== r.version) {
        throw new ToolError(
          `Version conflict: frame is at v${r.version}, you edited v${input.baseVersion}. Call get_frame for the latest HTML and reapply your change.`,
        );
      }
      // keep ids stable across rewrites: stamping only fills in what's missing
      const { html, count } = await stampElementIds(doc);
      this.sql.exec(
        "UPDATE frames SET html = ?, status = 'ready', task = NULL, lock = NULL, lock_expires = NULL, version = version + 1, name = COALESCE(?, name), width = COALESCE(?, width), updated_at = ? WHERE id = ?",
        html, input.name ?? null, input.width ?? null, now, id,
      );
      const frame = this.summarize(this.row(id));
      this.broadcast({ type: "frame", frame });
      return { frame, html, elementCount: count };
    }

    if (!input.name) throw new ToolError("A name is required to create a new frame.");
    id = newFrameId();
    const { html, count } = await stampElementIds(doc);
    this.sql.exec(
      "INSERT INTO frames (id, name, html, status, version, position, width, created_at, updated_at) VALUES (?, ?, ?, 'ready', 1, ?, ?, ?, ?)",
      id, input.name, html, this.nextPosition(), input.width ?? null, now, now,
    );
    const frame = this.summarize(this.row(id));
    this.broadcast({ type: "frame", frame });
    return { frame, html, elementCount: count };
  }

  /** Release a claim without writing (e.g. the agent gave up). */
  async releaseFrame(frameId: string, lock?: string) {
    this.requireFile();
    const r = this.row(frameId);
    this.assertClaimable(r, lock);
    if (!r.html) {
      this.sql.exec("DELETE FROM frames WHERE id = ?", frameId);
      this.broadcast({ type: "frame-deleted", id: frameId });
      return;
    }
    this.sql.exec("UPDATE frames SET status = 'ready', task = NULL, lock = NULL, lock_expires = NULL WHERE id = ?", frameId);
    this.broadcast({ type: "frame", frame: this.summarize(this.row(frameId)) });
  }

  async deleteFrame(frameId: string, lock?: string) {
    this.requireFile();
    const r = this.row(frameId);
    this.assertClaimable(r, lock);
    this.sql.exec("DELETE FROM frames WHERE id = ?", frameId);
    this.broadcast({ type: "frame-deleted", id: frameId });
  }

  // ---------- live canvas ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const session: ViewerSession = {
      viewer: (url.searchParams.get("v") ?? "").replace(/[^a-z0-9]/g, "").slice(0, 32),
      device: url.searchParams.get("d") === "touch" ? "touch" : "desktop",
      country: request.headers.get("x-ds-country") ?? "",
      start: Date.now(),
      activePings: 0,
    };
    pair[1].serializeAttachment(session);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message !== "ping" && message !== "ping:active") return;
    ws.send("pong");
    if (message === "ping:active") {
      const session = ws.deserializeAttachment() as ViewerSession | null;
      if (session) ws.serializeAttachment({ ...session, activePings: session.activePings + 1 });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    await this.endSession(ws);
    try {
      ws.close(code, "bye");
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    await this.endSession(ws);
  }

  /** One "session" event per canvas connection: how long it was open and how much of that was engaged. */
  private async endSession(ws: WebSocket) {
    const session = ws.deserializeAttachment() as ViewerSession | null;
    if (!session?.viewer) return;
    ws.serializeAttachment(null); // close and error can both fire; report once
    await track(this.env, {
      event: "session",
      name: "canvas",
      fileId: this.meta("id") ?? undefined,
      actor: session.viewer,
      detail: session.device,
      country: session.country,
      ms: Date.now() - session.start,
      size: session.activePings * PING_MS,
    });
  }

  private broadcast(msg: Broadcast) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}
