import { $, commenter, escapeHtml, toast, viewerId } from "./shared";
import { renderMarkdown } from "./markdown";

// mirrors src/design-file.ts
export interface FrameNotes {
  frameId: string;
  body: string;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  updatedByKind: "person" | "agent" | null;
}

/** What the notes panel needs from the canvas. */
export interface NotesHost {
  fileId: string;
  selected(): string | null;
  frameName(id: string): string | undefined;
  hasFrame(id: string): boolean;
  /** Select a frame, or one element in it, from a link in the notes. */
  open(frameId: string, elementId?: string): void;
  /** Outline an element in a frame while a link to it is hovered; null clears. */
  hover(frameId: string, elementId: string | null): void;
  setHasNotes(frameId: string, has: boolean): void;
  /** The panel just opened: keep the frame it describes in view. */
  shown(): void;
}

function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Notes: one markdown doc per frame, beside the screen, that people and agents
 * both edit. The panel follows the selected frame. Saves carry the version they
 * started from, so two editors can't silently overwrite each other.
 */
export function initNotes(host: NotesHost) {
  const panel = $("#notesPanel");
  const title = panel.querySelector<HTMLElement>(".frame")!;
  const view = panel.querySelector<HTMLElement>(".md")!;
  const form = panel.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const by = panel.querySelector<HTMLElement>(".by")!;
  const banner = panel.querySelector<HTMLElement>(".banner")!;
  const editBtn = panel.querySelector<HTMLButtonElement>("[data-act=edit]")!;
  const btn = $("#notesBtn");

  const cache = new Map<string, FrameNotes>();
  let on = false;
  let frameId: string | null = null;
  /** While editing: the version the draft started from, and whether someone saved since. */
  let editing: { frameId: string; base: number; stale: FrameNotes | null } | null = null;
  let saving = false;

  const api = async (id: string, method = "GET", body?: unknown): Promise<FrameNotes> => {
    const res = await fetch(`/api/files/${host.fileId}/frames/${id}/notes`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data as FrameNotes;
  };

  function render() {
    panel.hidden = !on;
    btn.setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("notes-open", on);
    if (!on) return;
    const name = frameId ? host.frameName(frameId) : undefined;
    title.textContent = name ?? "";
    title.hidden = !name;
    const n = frameId ? cache.get(frameId) : undefined;
    const isEditing = !!editing && editing.frameId === frameId;
    form.hidden = !isEditing;
    view.hidden = isEditing;
    editBtn.hidden = isEditing || !frameId;
    editBtn.querySelector(".label")!.textContent = n?.body ? "Edit" : "Write";
    if (!frameId) {
      view.innerHTML = `<p class="notes-empty">Select a frame to see its notes.</p>`;
      by.textContent = "";
    } else if (!n) {
      view.innerHTML = `<p class="notes-empty">Loading…</p>`;
      by.textContent = "";
    } else {
      view.innerHTML = n.body
        ? renderMarkdown(n.body)
        : `<p class="notes-empty">No notes yet. Keep what the screen can't show here: the issues it relates to, behavior and states, decisions, open questions. Your agent reads and writes these too.</p>`;
      wireLinks();
      by.textContent = n.version ? `v${n.version} · ${n.updatedByKind === "agent" ? "✦ " : ""}${n.updatedBy} · ${ago(n.updatedAt!)}` : "";
    }
    const stale = isEditing ? editing!.stale : null;
    banner.hidden = !stale;
    if (stale) banner.innerHTML = `${escapeHtml(stale.updatedBy ?? "Someone")} just saved these notes. <button type="button" class="btn" data-act="theirs">Use theirs</button> <button type="button" class="btn" data-act="mine">Keep mine</button>`;
  }

  /** Links in notes: element and frame links act on the canvas; everything else opens in a new tab. */
  function wireLinks() {
    for (const a of view.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const ref = canvasRef(a.getAttribute("href")!);
      if (!ref) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        continue;
      }
      a.classList.add("ref");
      a.dataset.frame = ref.frameId;
      if (ref.elementId) a.dataset.el = ref.elementId;
    }
  }
  /** #<element> in this frame, #<frame>, #<frame>/<element>, or a full link into this file. */
  function canvasRef(href: string): { frameId: string; elementId?: string } | null {
    let frag: string;
    if (href.startsWith("#")) frag = href.slice(1);
    else {
      const m = href.match(/^(?:https?:\/\/[^/]+)?\/f\/([a-z0-9]+)\/([a-z0-9]+)(?:#([a-z0-9,]+))?$/);
      if (!m || m[1] !== host.fileId) return null;
      return { frameId: m[2], elementId: m[3]?.split(",")[0] };
    }
    const [a, b] = frag.split("/");
    if (!/^[a-z0-9]+$/.test(a)) return null;
    if (b) return host.hasFrame(a) ? { frameId: a, elementId: b } : null;
    if (host.hasFrame(a)) return { frameId: a };
    return frameId ? { frameId, elementId: a } : null;
  }

  view.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref");
    if (!a) return;
    e.preventDefault();
    host.hover(a.dataset.frame!, null);
    host.open(a.dataset.frame!, a.dataset.el);
  });
  view.addEventListener("mouseover", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref[data-el]");
    if (a) host.hover(a.dataset.frame!, a.dataset.el!);
  });
  view.addEventListener("mouseout", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref[data-el]");
    if (a && !a.contains(e.relatedTarget as Node)) host.hover(a.dataset.frame!, null);
  });
  view.addEventListener("dblclick", (e) => {
    if (!(e.target as Element).closest("a")) edit();
  });

  async function fetchNotes(id: string) {
    try {
      cache.set(id, await api(id));
      if (id === frameId) render();
    } catch (err) {
      if (id === frameId) view.innerHTML = `<p class="notes-empty">${escapeHtml((err as Error).message)}</p>`;
    }
  }

  function edit() {
    if (!frameId || editing) return;
    const n = cache.get(frameId);
    if (!n) return;
    editing = { frameId, base: n.version, stale: null };
    input.value = n.body;
    render();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Save the draft if it changed. Resolves false when a conflict needs the person's call. */
  async function commit(force = false): Promise<boolean> {
    if (!editing || saving) return !editing;
    const e = editing;
    const cur = cache.get(e.frameId);
    if (input.value.trimEnd() === (cur?.body ?? "") && !force) {
      editing = null;
      render();
      return true;
    }
    saving = true;
    try {
      const base = force && e.stale ? e.stale.version : e.base;
      const n = await api(e.frameId, "PUT", { body: input.value, baseVersion: base, by: commenter().name, viewer: viewerId() });
      cache.set(e.frameId, n);
      host.setHasNotes(e.frameId, !!n.body);
      editing = null;
      render();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        e.stale = await api(e.frameId).catch(() => null);
        if (e.stale) cache.set(e.frameId, e.stale);
        render();
        input.focus();
      } else toast(escapeHtml((err as Error).message), 4000);
      return false;
    } finally {
      saving = false;
    }
  }

  function cancel() {
    editing = null;
    render();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    commit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  });
  panel.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "edit") edit();
    else if (act === "cancel") cancel();
    else if (act === "close") toggle(false);
    else if (act === "mine") commit(true);
    else if (act === "theirs") cancel();
  });

  async function toggle(next = !on) {
    if (!next && !(await commit())) return;
    on = next;
    if (on) follow();
    render();
    if (on) host.shown();
  }

  /** Show the selected frame's notes, saving any draft on the one we're leaving. */
  async function follow() {
    const id = host.selected();
    if (id === frameId) return;
    if (editing && editing.frameId !== id && !(await commit())) return;
    frameId = id;
    render();
    if (id) fetchNotes(id);
  }

  return {
    on: () => on,
    toggle,
    onSelect() {
      if (on) follow();
    },
    /** Esc closes the panel (a draft is saved first). */
    escape(): boolean {
      if (!on) return false;
      toggle(false);
      return true;
    },
    /** Enter starts editing while the panel is open. */
    edit(): boolean {
      if (!on || !frameId || editing) return false;
      edit();
      return true;
    },
    onMessage(n: FrameNotes) {
      host.setHasNotes(n.frameId, !!n.body);
      if (!cache.has(n.frameId) && n.frameId !== frameId) return;
      const mine = editing && editing.frameId === n.frameId;
      if (mine && !saving && n.version !== editing!.base) editing!.stale = n;
      cache.set(n.frameId, n);
      if (n.frameId === frameId) render();
    },
    /** The frame was deleted or the file reloaded: drop what we know. */
    reset() {
      cache.clear();
      if (on && frameId && !editing) fetchNotes(frameId);
    },
  };
}
