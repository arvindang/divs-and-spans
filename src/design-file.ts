import { DurableObject } from "cloudflare:workers";
import { newCommentId, newEmbedKey, newFrameId, newLockToken, newThreadId } from "./ids";
import { flowMap, normalizeDocument, resolveElement, stampElementIds } from "./html";
import type { Env } from "./index";
import { track } from "./analytics";

/** How long a start_frame claim holds before another session may take the frame. */
const LOCK_MS = 10 * 60 * 1000;

/** The canvas pings every 25s; a ping marked active (visible tab, recent input) counts as that much engaged time. */
const PING_MS = 25 * 1000;
/** The embeds row for a whole-file embed. Frame ids are a-z0-9, so it never collides. */
const FILE_EMBED = "*";

/** Deleted files and frames wait this long in the trash, where anyone with the link can restore them, before they're erased. */
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;

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

/** A file in the trash: what the canvas shows instead of the frames. */
export interface TrashedFile {
  id: string;
  name: string;
  deletedAt: number;
  purgeAt: number;
}

export interface TrashedFrame {
  id: string;
  name: string;
  deletedAt: number;
  purgeAt: number;
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
  deleted_at: number | null;
  [key: string]: SqlStorageValue;
}

type Broadcast =
  | { type: "frame"; frame: FrameSummary }
  | { type: "frame-deleted"; id: string }
  | { type: "tokens"; version: number }
  | { type: "file"; name: string }
  | ({ type: "file-deleted" } & TrashedFile)
  | { type: "file-restored" }
  | { type: "thread"; thread: Thread }
  | { type: "thread-deleted"; id: string };

// ---------- comments ----------

const MAX_THREADS = 2000;
const MAX_COMMENTS_PER_THREAD = 200;
const MAX_BODY = 4000;

export type AuthorKind = "person" | "agent";
export type ThreadStatus = "open" | "resolved";

/** Who wrote a comment. There's no auth: people are a random id + name kept in their browser, and `secret` lets only that browser edit or delete what it wrote. */
export interface CommentAuthor {
  id: string;
  name: string;
  kind: AuthorKind;
  secret?: string;
}

/** What the commenter was looking at, since "this overlaps" depends on the device and theme. */
export interface ThreadView {
  device: string;
  w: number;
  h: number;
  theme: "light" | "dark";
}

/** The pinned element as it was when the thread started, so a deleted element can still be explained. */
export interface ElementSnapshot {
  tag: string;
  outer_html: string;
  path: string[];
}

export interface ThreadComment {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: AuthorKind;
  body: string;
  createdAt: number;
  editedAt: number | null;
}

/**
 * A comment thread. It's pinned to an element (x/y are fractions of the
 * element's box), to a spot on a frame (fractions of the frame's screen as
 * shown; outside 0..1 means beside the frame), or to nothing (a note on the file).
 */
export interface Thread {
  id: string;
  frameId: string | null;
  elementId: string | null;
  x: number | null;
  y: number | null;
  view: ThreadView | null;
  snapshot: ElementSnapshot | null;
  status: ThreadStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  comments: ThreadComment[];
}

interface ThreadRow {
  id: string;
  frame_id: string | null;
  element_id: string | null;
  x: number | null;
  y: number | null;
  view: string | null;
  snapshot: string | null;
  status: ThreadStatus;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author_id: string;
  author_name: string;
  author_kind: AuthorKind;
  author_key: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  [key: string]: SqlStorageValue;
}

const cleanBody = (body: string) => {
  const b = (body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!b) throw new ToolError("A comment needs some text.");
  if (b.length > MAX_BODY) throw new ToolError(`Comments are limited to ${MAX_BODY} characters.`);
  return b;
};

const cleanAuthor = (a: CommentAuthor): CommentAuthor => {
  const name = (a?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name || !/^[a-z0-9:_-]{2,48}$/i.test(a?.id ?? "")) throw new ToolError("A comment needs an author id and name.");
  if (a.kind === "person" && !/^[a-z0-9]{24,64}$/i.test(a.secret ?? "")) throw new ToolError("A comment needs the author's key.");
  return { id: a.id, name, kind: a.kind === "agent" ? "agent" : "person", secret: a.secret };
};

const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-50, Math.min(50, v)) : null);

async function keyHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ds-author:${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One Durable Object per design file. It owns the file's frames and tokens,
 * serializes every write (so claims can't race), and fans changes out to
 * every open canvas over hibernatable WebSockets.
 */
export class DesignFile extends DurableObject<Env> {
  private sql: SqlStorage;
  /** False until init() runs. Lookups of a file that doesn't exist must not write, or they'd count as stored objects. */
  private ready: boolean;
  /** Comment tables arrived after files existed, so they're created on the first comment, not in createSchema. */
  private commentsReady: boolean;
  /** Same for embeds: the table appears with the first one. */
  private embedsReady: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const tables = new Set(this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    this.ready = tables.has("meta");
    this.commentsReady = tables.has("threads");
    this.embedsReady = tables.has("embeds");
    // files made before the trash existed hard-deleted frames; give them the column (no migration layer, see createSchema)
    if (tables.has("frames") && !this.sql.exec<{ name: string }>("PRAGMA table_info(frames)").toArray().some((c) => c.name === "deleted_at")) {
      this.sql.exec("ALTER TABLE frames ADD COLUMN deleted_at INTEGER");
    }
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
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
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
  /** A trashed file reads as deleted everywhere except trashInfo() and restoreFile(). */
  private requireFile() {
    if (!this.meta("id")) throw new ToolError("Design file not found. Check the link, or create one with create_file.");
    const t = this.trashed();
    if (t) {
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      throw new ToolError(`This design file was deleted on ${day(t.deletedAt)}. Anyone with its link can restore it from the canvas until ${day(t.purgeAt)}.`);
    }
  }
  private trashed(): TrashedFile | null {
    const at = Number(this.meta("deleted_at"));
    return at ? { id: this.meta("id")!, name: this.meta("name")!, deletedAt: at, purgeAt: at + TRASH_MS } : null;
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

  /** The file's trash state, or null if it isn't trashed (or doesn't exist). Never throws, so the canvas can offer a restore. */
  async trashInfo(): Promise<TrashedFile | null> {
    return this.meta("id") ? this.trashed() : null;
  }

  /** Move the file to the trash. Every canvas on it switches to the restore screen; the alarm erases it after TRASH_MS. */
  async deleteFile(): Promise<TrashedFile> {
    this.requireFile();
    this.setMeta("deleted_at", String(Date.now()));
    await this.scheduleAlarm();
    const t = this.trashed()!;
    this.broadcast({ type: "file-deleted", ...t });
    return t;
  }

  async restoreFile(): Promise<FileState> {
    if (!this.meta("id")) this.requireFile();
    if (this.trashed()) {
      this.sql.exec("DELETE FROM meta WHERE key = 'deleted_at'");
      await this.scheduleAlarm();
      this.broadcast({ type: "file-restored" });
    }
    return this.getState();
  }

  async getState(): Promise<FileState> {
    this.requireFile();
    return {
      id: this.meta("id")!,
      name: this.meta("name")!,
      createdAt: Number(this.meta("created_at")),
      tokensVersion: Number(this.meta("tokens_version")),
      frames: this.sql
        .exec<FrameRow>("SELECT * FROM frames WHERE deleted_at IS NULL ORDER BY position ASC")
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

  private row(frameId: string, includeDeleted = false): FrameRow {
    const r = this.sql.exec<FrameRow>("SELECT * FROM frames WHERE id = ?", frameId).toArray()[0];
    if (!r) throw new ToolError(`Frame ${frameId} not found in this file.`);
    if (r.deleted_at && !includeDeleted) throw new ToolError(`Frame ${frameId} not found in this file: it was deleted, and the person can restore it from the canvas's Trash.`);
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
    const rows = this.sql.exec<{ id: string; html: string }>("SELECT id, html FROM frames WHERE html != '' AND deleted_at IS NULL").toArray();
    return flowMap(this.meta("id")!, rows);
  }

  /** Everything an export needs in one call: frames in canvas order with their html, tokens and flows. */
  async getExport() {
    const state = await this.getState();
    const html = new Map(
      this.sql.exec<{ id: string; html: string }>("SELECT id, html FROM frames WHERE html != '' AND deleted_at IS NULL").toArray().map((r) => [r.id, r.html]),
    );
    return {
      id: state.id,
      name: state.name,
      tokens: this.meta("tokens")!,
      tokensVersion: state.tokensVersion,
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
      const task = r.task ? ` (task: ${r.task})` : "";
      // sessions can't be told apart, so a call without the lock is as likely the claim holder's slip as a second session
      if (!lock) {
        throw new ToolError(
          `Frame "${r.name}" is claimed${task} and this call didn't pass its lock. If you claimed it with start_frame, call again with the lock it returned. ` +
            `Otherwise it's being worked on by another session: its claim expires in ~${mins} min, so work on a different frame or try again later.`,
        );
      }
      throw new ToolError(
        `Frame "${r.name}" is being worked on by another session${task}; the lock you passed isn't the current claim on this frame. ` +
          `Its claim expires in ~${mins} min. Work on a different frame or try again later.`,
      );
    }
  }

  /** Claim a frame (new or existing). The canvas shows a working state until write_frame. Passing the lock you hold renews the claim. */
  async startFrame(input: { frameId?: string; name?: string; task: string; width?: number | null; lock?: string }) {
    this.requireFile();
    const now = Date.now();
    let lock = newLockToken();
    let id = input.frameId;
    if (id) {
      const r = this.row(id);
      this.assertClaimable(r, input.lock);
      if (input.lock && r.lock === input.lock) lock = input.lock;
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

  /**
   * Move a frame to the trash. The agent needs the lock of a frame it claimed;
   * a person on the canvas can delete any frame (their call wins over a claim).
   */
  async deleteFrame(frameId: string, lock?: string, byPerson = false) {
    this.requireFile();
    const r = this.row(frameId);
    if (!byPerson) this.assertClaimable(r, lock);
    this.sql.exec(
      "UPDATE frames SET deleted_at = ?, status = 'ready', task = NULL, lock = NULL, lock_expires = NULL WHERE id = ?",
      Date.now(), frameId,
    );
    await this.scheduleAlarm();
    this.broadcast({ type: "frame-deleted", id: frameId });
  }

  async restoreFrame(frameId: string): Promise<FrameSummary> {
    this.requireFile();
    if (this.row(frameId, true).deleted_at) {
      this.sql.exec("UPDATE frames SET deleted_at = NULL WHERE id = ?", frameId);
      await this.scheduleAlarm();
    }
    const frame = this.summarize(this.row(frameId));
    this.broadcast({ type: "frame", frame });
    return frame;
  }

  /** Deleted frames, newest first. */
  async listTrash(): Promise<TrashedFrame[]> {
    this.requireFile();
    return this.sql
      .exec<{ id: string; name: string; deleted_at: number }>("SELECT id, name, deleted_at FROM frames WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at, purgeAt: r.deleted_at + TRASH_MS }));
  }

  // ---------- trash ----------

  /** One alarm covers the trash: it fires when the oldest deleted thing (the file or a frame) is due to be erased. */
  private async scheduleAlarm() {
    const due = [Number(this.meta("deleted_at")), this.sql.exec<{ t: number | null }>("SELECT MIN(deleted_at) AS t FROM frames").toArray()[0]?.t ?? 0]
      .filter((t) => t > 0)
      .map((t) => t + TRASH_MS);
    if (due.length) await this.ctx.storage.setAlarm(Math.min(...due));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.ready) return;
    const cutoff = Date.now() - TRASH_MS;
    const fileDeleted = Number(this.meta("deleted_at"));
    if (fileDeleted && fileDeleted <= cutoff) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "deleted");
        } catch {}
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.ready = false;
      this.commentsReady = false;
      this.embedsReady = false;
      return;
    }
    const gone = this.sql.exec<{ id: string }>("SELECT id FROM frames WHERE deleted_at IS NOT NULL AND deleted_at <= ?", cutoff).toArray().map((r) => r.id);
    for (const id of gone) {
      if (this.commentsReady) {
        this.sql.exec("DELETE FROM comments WHERE thread_id IN (SELECT id FROM threads WHERE frame_id = ?)", id);
        this.sql.exec("DELETE FROM threads WHERE frame_id = ?", id);
      }
      if (this.embedsReady) this.sql.exec("DELETE FROM embeds WHERE frame_id = ?", id);
      this.sql.exec("DELETE FROM frames WHERE id = ?", id);
    }
    await this.scheduleAlarm();
  }

  // ---------- comments ----------

  private ensureComments() {
    if (this.commentsReady) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        frame_id TEXT,
        element_id TEXT,
        x REAL,
        y REAL,
        view TEXT,
        snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_by TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_key TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS comments_by_thread ON comments (thread_id, created_at);
    `);
    this.commentsReady = true;
  }

  private toThread(r: ThreadRow, comments: CommentRow[]): Thread {
    return {
      id: r.id,
      frameId: r.frame_id,
      elementId: r.element_id,
      x: r.x,
      y: r.y,
      view: r.view ? (JSON.parse(r.view) as ThreadView) : null,
      snapshot: r.snapshot ? (JSON.parse(r.snapshot) as ElementSnapshot) : null,
      status: r.status,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      comments: comments.map((c) => ({
        id: c.id,
        authorId: c.author_id,
        authorName: c.author_name,
        authorKind: c.author_kind,
        body: c.body,
        createdAt: c.created_at,
        editedAt: c.edited_at,
      })),
    };
  }

  private thread(threadId: string): Thread {
    const r = this.commentsReady ? this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId).toArray()[0] : undefined;
    if (!r) throw new ToolError(`Comment ${threadId} not found in this file.`);
    return this.toThread(r, this.sql.exec<CommentRow>("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at ASC", threadId).toArray());
  }

  /** Threads oldest first. Reads never create the comment tables. */
  async listThreads(filter: { frameId?: string; status?: ThreadStatus } = {}): Promise<Thread[]> {
    this.requireFile();
    if (!this.commentsReady) return [];
    const where: string[] = [];
    const args: string[] = [];
    if (filter.frameId) where.push("frame_id = ?"), args.push(filter.frameId);
    if (filter.status) where.push("status = ?"), args.push(filter.status);
    const rows = this.sql.exec<ThreadRow>(`SELECT * FROM threads${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`, ...args).toArray();
    if (!rows.length) return [];
    const byThread = new Map<string, CommentRow[]>();
    for (const c of this.sql.exec<CommentRow>("SELECT * FROM comments ORDER BY created_at ASC").toArray()) {
      if (!byThread.has(c.thread_id)) byThread.set(c.thread_id, []);
      byThread.get(c.thread_id)!.push(c);
    }
    return rows.map((r) => this.toThread(r, byThread.get(r.id) ?? []));
  }

  async getThread(threadId: string): Promise<Thread> {
    this.requireFile();
    return this.thread(threadId);
  }

  private async insertComment(threadId: string, body: string, author: CommentAuthor, now: number) {
    const key = author.kind === "person" && author.secret ? await keyHash(author.secret) : null;
    this.sql.exec(
      "INSERT INTO comments (id, thread_id, author_id, author_name, author_kind, author_key, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      newCommentId(), threadId, author.id, author.name, author.kind, key, body, now,
    );
  }

  /** Start a thread on an element, a spot on a frame, or the file itself. */
  async createThread(input: {
    frameId?: string | null;
    elementId?: string | null;
    x?: number | null;
    y?: number | null;
    view?: ThreadView | null;
    body: string;
    author: CommentAuthor;
  }): Promise<Thread> {
    this.requireFile();
    const body = cleanBody(input.body);
    const author = cleanAuthor(input.author);
    const frameId = input.frameId || null;
    const elementId = frameId ? input.elementId || null : null;
    let snapshot: ElementSnapshot | null = null;
    if (frameId) {
      const r = this.row(frameId);
      if (elementId) {
        const el = resolveElement(r.html, elementId, 3000);
        if (!el) throw new ToolError(`Element ${elementId} not found in frame "${r.name}".`);
        snapshot = { tag: el.tag, outer_html: el.outer_html, path: el.path };
      }
    }
    this.ensureComments();
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM threads").toArray()[0].n;
    if (count >= MAX_THREADS) throw new ToolError(`This file has reached ${MAX_THREADS} comment threads. Delete some resolved ones first.`);
    const v = input.view;
    const size = (n: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(n)) || 0));
    const view: ThreadView | null = v && typeof v.device === "string"
      ? { device: v.device.slice(0, 40), w: size(v.w, 4000), h: size(v.h, 12000), theme: v.theme === "dark" ? "dark" : "light" }
      : null;
    const now = Date.now();
    const id = newThreadId();
    this.sql.exec(
      "INSERT INTO threads (id, frame_id, element_id, x, y, view, snapshot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      id, frameId, elementId, frameId ? finite(input.x) : null, frameId ? finite(input.y) : null,
      view ? JSON.stringify(view) : null, snapshot ? JSON.stringify(snapshot) : null, now, now,
    );
    await this.insertComment(id, body, author, now);
    const thread = this.thread(id);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Reply to a thread. A reply on a resolved thread reopens it: someone still has something to say. */
  async reply(threadId: string, rawBody: string, rawAuthor: CommentAuthor): Promise<Thread> {
    this.requireFile();
    const body = cleanBody(rawBody);
    const author = cleanAuthor(rawAuthor);
    const t = this.thread(threadId);
    if (t.comments.length >= MAX_COMMENTS_PER_THREAD) throw new ToolError(`This thread has reached ${MAX_COMMENTS_PER_THREAD} replies. Start a new one.`);
    const now = Date.now();
    await this.insertComment(threadId, body, author, now);
    this.sql.exec("UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Resolve or reopen. Anyone with the file can, as in other design tools. */
  async setThreadStatus(threadId: string, status: ThreadStatus, byName: string): Promise<Thread> {
    this.requireFile();
    this.thread(threadId);
    const now = Date.now();
    const by = (byName ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Someone";
    if (status === "resolved") {
      this.sql.exec("UPDATE threads SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", by, now, now, threadId);
    } else {
      this.sql.exec("UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, threadId);
    }
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  private async ownComment(threadId: string, commentId: string, secret: string | undefined) {
    this.thread(threadId);
    const c = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ? AND thread_id = ?", commentId, threadId).toArray()[0];
    if (!c) throw new ToolError(`Comment ${commentId} not found in this thread.`);
    if (!c.author_key || !secret || c.author_key !== (await keyHash(secret))) {
      throw new ToolError("That comment was written in another browser. Only its author can change it.");
    }
    return c;
  }

  async editComment(threadId: string, commentId: string, rawBody: string, secret?: string): Promise<Thread> {
    this.requireFile();
    const body = cleanBody(rawBody);
    await this.ownComment(threadId, commentId, secret);
    const now = Date.now();
    this.sql.exec("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", body, now, commentId);
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", now, threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Delete your own comment. The thread goes with its last comment. */
  async deleteComment(threadId: string, commentId: string, secret?: string): Promise<Thread | null> {
    this.requireFile();
    await this.ownComment(threadId, commentId, secret);
    this.sql.exec("DELETE FROM comments WHERE id = ?", commentId);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?", threadId).toArray()[0].n;
    if (!left) {
      this.sql.exec("DELETE FROM threads WHERE id = ?", threadId);
      this.broadcast({ type: "thread-deleted", id: threadId });
      return null;
    }
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  // ---------- embeds ----------
  // A read-only view for Notion, Confluence and the like: one frame and the frames it links
  // to, or the whole file (frame_id FILE_EMBED). Its key never reveals the file id, which
  // would grant edit access to everything.

  private ensureEmbeds() {
    if (this.embedsReady) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS embeds (
        key TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `);
    this.embedsReady = true;
  }

  /** The embed key for a frame, or for the whole file when frameId is null. Never creates anything. */
  async getEmbed(frameId: string | null): Promise<string | null> {
    this.requireFile();
    if (frameId) this.row(frameId);
    if (!this.embedsReady) return null;
    return this.sql.exec<{ key: string }>("SELECT key FROM embeds WHERE frame_id = ?", frameId ?? FILE_EMBED).toArray()[0]?.key ?? null;
  }

  /** One embed per frame and one for the file: returns the existing key or makes one. */
  async createEmbed(frameId: string | null): Promise<string> {
    const existing = await this.getEmbed(frameId);
    if (existing) return existing;
    this.ensureEmbeds();
    const key = newEmbedKey();
    this.sql.exec("INSERT INTO embeds (key, frame_id, created_at) VALUES (?, ?, ?)", key, frameId ?? FILE_EMBED, Date.now());
    return key;
  }

  /** Turn an embed off: its link stops working and open players are told so. */
  async revokeEmbed(frameId: string | null): Promise<void> {
    const key = await this.getEmbed(frameId);
    if (!key) return;
    this.sql.exec("DELETE FROM embeds WHERE key = ?", key);
    for (const ws of this.ctx.getWebSockets(`embed:${key}`)) {
      try {
        ws.close(4004, "revoked");
      } catch {}
    }
  }

  private embedStart(key: string): string {
    this.requireFile();
    const r = this.embedsReady ? this.sql.exec<{ frame_id: string }>("SELECT frame_id FROM embeds WHERE key = ?", key).toArray()[0] : undefined;
    if (!r) throw new ToolError("Embed not found: it was turned off, or the link is wrong.");
    return r.frame_id;
  }

  /** What an embed may show: every frame for a file embed, else its frame and every frame reachable from it by flows. */
  async getEmbedState(key: string) {
    const scope = this.embedStart(key);
    const file = scope === FILE_EMBED;
    const rows = this.sql.exec<FrameRow>("SELECT * FROM frames WHERE html != '' AND deleted_at IS NULL ORDER BY position").toArray();
    const start = file ? rows[0]?.id ?? "" : scope;
    const startName = file ? this.meta("name")! : this.row(start).name;
    const { flows } = flowMap(this.meta("id")!, rows);
    const reach = new Set(file ? rows.map((r) => r.id) : [start]);
    for (let grew = !file; grew; ) {
      grew = false;
      for (const f of flows) {
        if (reach.has(f.from) && !reach.has(f.to)) reach.add(f.to), (grew = true);
      }
    }
    return {
      fileId: this.meta("id")!,
      name: this.meta("name")!,
      scope: file ? ("file" as const) : ("frame" as const),
      start,
      startName,
      tokensVersion: Number(this.meta("tokens_version")),
      frames: rows
        .filter((r) => reach.has(r.id))
        .sort((a, b) => (a.id === start ? -1 : b.id === start ? 1 : 0))
        .map((r) => ({ id: r.id, name: r.name, version: r.version, width: r.width })),
      flows: flows.filter((f) => reach.has(f.from)).map((f) => ({ from: f.from, element: f.element, to: f.to, toElement: f.to_element ?? null })),
    };
  }

  /** A frame's HTML through an embed, only if the embed can reach it. */
  async getEmbedFrame(key: string, frameId: string) {
    const state = await this.getEmbedState(key);
    if (!state.frames.some((f) => f.id === frameId)) throw new ToolError(`Frame ${frameId} not found in this embed.`);
    return { html: this.row(frameId).html, tokensVersion: state.tokensVersion };
  }

  async getEmbedTokens(key: string) {
    this.embedStart(key);
    return this.getTokens();
  }

  // ---------- live canvas ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const embed = url.searchParams.get("embed");
    if (embed) {
      try {
        this.embedStart(embed);
      } catch (e) {
        return new Response(e instanceof Error ? e.message : "Not found", { status: /deleted/.test(String(e)) ? 410 : 404 });
      }
    }
    const pair = new WebSocketPair();
    // embed players get a bare "changed" signal, never comments or frame names outside their reach
    this.ctx.acceptWebSocket(pair[1], embed ? ["embed", `embed:${embed}`] : []);
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
    const changed = msg.type === "thread" || msg.type === "thread-deleted" ? null : `{"type":"changed"}`;
    for (const ws of this.ctx.getWebSockets()) {
      const embed = this.ctx.getTags(ws).includes("embed");
      if (embed && !changed) continue;
      try {
        ws.send(embed ? changed! : data);
      } catch {}
    }
  }
}
