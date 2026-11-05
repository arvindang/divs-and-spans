import { $, authorColor, commenter, copy, escapeHtml, renameCommenter, toast, viewerId } from "./shared";

// ---------- types (mirror src/design-file.ts) ----------
interface ThreadComment {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: "person" | "agent";
  body: string;
  createdAt: number;
  editedAt: number | null;
}
interface Thread {
  id: string;
  frameId: string | null;
  elementId: string | null;
  x: number | null;
  y: number | null;
  snapshot: { tag: string } | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  createdAt: number;
  comments: ThreadComment[];
}
type Status = Thread["status"];
type Spot = { frameId: string | null; elementId: string | null; x: number | null; y: number | null };
type ScreenRect = { x: number; y: number; w: number; h: number };

/** What the comments layer needs from the canvas. */
export interface CommentsHost {
  fileId: string;
  frameName(id: string): string | undefined;
  frameOrder(): string[];
  primaryIframe(id: string): HTMLIFrameElement | null;
  /** The device and theme on screen, saved with a new thread. */
  view(): { device: string; w: number; h: number; theme: "light" | "dark" };
  revealScreenRect(r: ScreenRect, maxZ: number): void;
  select(frameId: string | null): void;
  /** Comment mode and element select are one tool at a time. */
  stopPicking(): void;
  forEachDoc(fn: (doc: Document) => void): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const initials = (c: ThreadComment) =>
  c.authorKind === "agent" ? "✦" : c.authorName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const avatar = (c: ThreadComment) =>
  `<span class="av${c.authorKind === "agent" ? " agent" : ""}" style="--c:${c.authorKind === "agent" ? "var(--accent)" : authorColor(c.authorId)}">${escapeHtml(initials(c))}</span>`;
function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const describe = (el: Element) => {
  const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
  return `${el.tagName.toLowerCase()}${cls.length ? "." + cls.join(".") : ""}`;
};

export function initComments(host: CommentsHost) {
  const viewport = $("#viewport");
  const panel = $("#commentsPanel");
  const list = panel.querySelector<HTMLElement>(".threads")!;
  const pinsEl = $("#pins");
  const pop = $("#thread");
  const head = pop.querySelector<HTMLElement>(".head")!;
  const items = pop.querySelector<HTMLElement>(".items")!;
  const form = pop.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const btn = $("#commentBtn");
  const phone = matchMedia("(max-width: 820px)");

  const threads = new Map<string, Thread>();
  let on = false;
  let filter: Status = "open";
  /** The open popover: a thread, or a new one not posted yet. */
  let active: { id: string } | { draft: Spot } | null = null;
  /** Editing one of your own comments in the popover's box instead of replying. */
  let editing: string | null = null;
  let formFor = "";
  const pinEls = new Map<string, HTMLButtonElement>();
  let raf = 0;
  let wanted = new URLSearchParams(location.search).get("c");

  const api = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`/api/files/${host.fileId}/comments${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  const failed = (err: unknown) => toast(escapeHtml((err as Error).message || "Couldn't save the comment"), 4000);
  const upsert = (t: Thread | null | undefined) => t && threads.set(t.id, t);
  const activeThread = () => (active && "id" in active ? threads.get(active.id) ?? null : null);
  const linkTo = (t: Thread) => `${location.origin}/f/${host.fileId}${t.frameId ? `/${t.frameId}` : ""}?c=${t.id}`;
  const shown = (t: Thread) => t.status === filter || activeThread()?.id === t.id;

  // ---------- where a pin sits on screen ----------
  /** Element pins hold a spot in the element's box; frame pins a spot in the frame's (outside 0..1 is beside it). */
  function anchorOf(s: Spot): { x: number; y: number; off: boolean; detached: boolean; box?: ScreenRect } | null {
    if (!s.frameId) return null;
    const iframe = host.primaryIframe(s.frameId);
    if (!iframe) return null;
    const clip = iframe.getBoundingClientRect();
    const fx = s.x ?? 1;
    const fy = s.y ?? 0;
    if (s.elementId) {
      const el = iframe.contentDocument?.querySelector(`[data-ds="${CSS.escape(s.elementId)}"]`);
      const r = el?.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return { x: clip.right, y: clip.top, off: false, detached: true };
      const k = clip.width / iframe.clientWidth;
      const box = { x: clip.left + r.left * k, y: clip.top + r.top * k, w: r.width * k, h: r.height * k };
      const x = box.x + fx * box.w;
      const y = box.y + fy * box.h;
      const off = y < clip.top || y > clip.bottom || x < clip.left || x > clip.right;
      return { x: clamp(x, clip.left, clip.right), y: clamp(y, clip.top, clip.bottom), off, detached: false, box };
    }
    return { x: clip.left + fx * clip.width, y: clip.top + fy * clip.height, off: false, detached: false };
  }

  function schedule() {
    if (on) raf ||= requestAnimationFrame(draw);
  }
  function draw() {
    raf = 0;
    if (!on) return;
    const seen = new Set<string>();
    const place = (key: string, s: Spot, html: string, cls: string, title: string) => {
      const a = anchorOf(s);
      if (!a) return;
      seen.add(key);
      let pin = pinEls.get(key);
      if (!pin) {
        pin = document.createElement("button");
        pin.dataset.thread = key;
        pinsEl.append(pin);
        pinEls.set(key, pin);
      }
      pin.className = `pin ${cls}${a.off ? " off" : ""}${a.detached ? " detached" : ""}`;
      if (pin.innerHTML !== html) pin.innerHTML = html;
      pin.title = title + (a.detached ? " · its element was removed" : a.off ? " · scrolled out of view" : "");
      pin.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)`;
    };
    const cur = activeThread()?.id;
    for (const t of threads.values()) {
      if (!shown(t) || !t.comments.length) continue;
      const first = t.comments[0];
      const n = t.comments.length;
      place(t.id, t, `${avatar(first)}${n > 1 ? `<i>${n}</i>` : ""}`, `${t.status}${t.id === cur ? " active" : ""}`,
        `${first.authorName}: ${first.body.slice(0, 80)}`);
    }
    if (active && "draft" in active) place("draft", active.draft, `<span class="av" style="--c:var(--accent)">+</span>`, "draft active", "New comment");
    for (const [key, el] of pinEls) {
      if (!seen.has(key)) {
        el.remove();
        pinEls.delete(key);
      }
    }
    positionPopover();
  }

  function positionPopover() {
    if (pop.hidden || phone.matches) return;
    const spot = active && ("draft" in active ? active.draft : activeThread());
    const a = spot ? anchorOf(spot) : null;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    // no pin (a note on the file, a deleted frame): beside the panel
    const panelLeft = panel.hidden ? innerWidth : panel.getBoundingClientRect().left;
    let x = a ? a.x + 22 : panelLeft - w - 12;
    let y = a ? a.y - 18 : 64;
    if (a && x + w > panelLeft - 8) x = a.x - w - 22;
    x = clamp(x, 8, innerWidth - w - 8);
    y = clamp(y, 56, innerHeight - h - 12);
    pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------- popover ----------
  function where(s: Spot, t?: Thread) {
    if (!s.frameId) return "Whole file";
    const name = host.frameName(s.frameId);
    if (!name) return "Deleted frame";
    if (!s.elementId) {
      const beside = s.x !== null && s.y !== null && (s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1);
      return `${beside ? "Beside " : ""}${escapeHtml(name)}`;
    }
    const el = host.primaryIframe(s.frameId)?.contentDocument?.querySelector(`[data-ds="${CSS.escape(s.elementId)}"]`);
    const what = el ? describe(el) : t?.snapshot ? `${t.snapshot.tag} (removed)` : "element";
    return `${escapeHtml(name)} · <code>${escapeHtml(what)}</code>`;
  }

  function renderPopover() {
    if (!active || !on) {
      pop.hidden = true;
      return;
    }
    const me = commenter();
    const t = activeThread();
    if ("id" in active && !t) return close();
    pop.hidden = false;
    pop.classList.toggle("resolved", t?.status === "resolved");
    if (t) {
      const resolved = t.status === "resolved";
      head.innerHTML =
        `<span class="where">${where(t, t)}</span>` +
        `<button class="btn icon" data-act="status" title="${resolved ? "Reopen" : "Resolve"}" aria-pressed="${resolved}">${resolved ? "Reopen" : "✓ Resolve"}</button>` +
        `<button class="btn icon" data-act="link" title="Copy link to this comment">Link</button>` +
        `<button class="btn icon" data-act="close" aria-label="Close">✕</button>`;
      items.innerHTML = t.comments.map((c) => {
        const mine = c.authorKind === "person" && c.authorId === me.id;
        return `<li data-comment="${c.id}">${avatar(c)}<div class="body">` +
          `<div class="meta"><b>${escapeHtml(c.authorName)}</b>${c.authorKind === "agent" ? `<span class="tag">agent</span>` : ""}` +
          `<time title="${new Date(c.createdAt).toLocaleString()}">${ago(c.createdAt)}${c.editedAt ? " · edited" : ""}</time>` +
          (mine ? `<span class="own"><button data-act="edit">Edit</button><button data-act="delete">Delete</button></span>` : "") +
          `</div><p>${escapeHtml(c.body)}</p></div></li>`;
      }).join("") + (resolved ? `<li class="note">Resolved by ${escapeHtml(t.resolvedBy ?? "someone")}. Replying reopens it.</li>` : "");
    } else {
      head.innerHTML = `<span class="where">${where((active as { draft: Spot }).draft)}</span><button class="btn icon" data-act="close" aria-label="Close">✕</button>`;
      items.innerHTML = "";
    }
    // keep what's being typed when a live update re-renders the thread
    const key = `${t?.id ?? "draft"}:${editing ?? ""}`;
    if (key !== formFor) {
      formFor = key;
      const c = editing ? t?.comments.find((x) => x.id === editing) : null;
      input.value = c?.body ?? "";
      input.placeholder = t ? "Reply…" : "Add a comment…";
      submit.textContent = editing ? "Save" : t ? "Reply" : "Post";
      if (!coarse()) requestAnimationFrame(() => input.focus());
    }
    form.querySelector<HTMLElement>(".as")!.innerHTML = editing
      ? `Editing · <button type="button" data-act="cancel">Cancel</button>`
      : `as <b style="color:${authorColor(me.id)}">${escapeHtml(me.name)}</b>`;
    requestAnimationFrame(positionPopover);
  }
  const coarse = () => matchMedia("(pointer: coarse)").matches;

  function open(next: typeof active) {
    active = next;
    editing = null;
    formFor = "";
    const t = activeThread();
    const path = location.pathname;
    history.replaceState(null, "", t ? `/f/${host.fileId}${t.frameId ? `/${t.frameId}` : ""}?c=${t.id}` : path + location.hash);
    renderPopover();
    renderPanel();
    schedule();
  }
  function close() {
    if (!active) return;
    active = null;
    editing = null;
    formFor = "";
    pop.hidden = true;
    if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    renderPanel();
    schedule();
  }

  async function send() {
    const body = input.value.trim();
    if (!body || !active) return;
    const me = commenter();
    const author = { id: me.id, name: me.name, secret: me.secret };
    submit.disabled = true;
    try {
      const t = activeThread();
      if ("draft" in active) {
        const created = (await api("", "POST", { ...active.draft, view: host.view(), body, author, viewer: viewerId() })) as Thread;
        upsert(created);
        open({ id: created.id });
      } else if (t && editing) {
        upsert((await api(`/${t.id}/${editing}`, "PATCH", { body, secret: me.secret })) as Thread);
        editing = null;
        formFor = "";
      } else if (t) {
        upsert((await api(`/${t.id}`, "POST", { body, author, viewer: viewerId() })) as Thread);
        if (filter !== "open") filter = "open";
        formFor = "";
      }
      input.value = "";
      renderPopover();
      renderPanel();
      schedule();
    } catch (err) {
      failed(err);
    } finally {
      submit.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (editing) {
        editing = null;
        renderPopover();
      } else close();
    }
  });

  pop.addEventListener("click", async (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    const t = activeThread();
    const me = commenter();
    if (act === "close") return close();
    if (act === "cancel") {
      editing = null;
      return renderPopover();
    }
    if (!t) return;
    const commentId = (e.target as Element).closest<HTMLElement>("[data-comment]")?.dataset.comment;
    try {
      if (act === "link") copy(linkTo(t), "Copied comment link");
      else if (act === "status") {
        const status: Status = t.status === "open" ? "resolved" : "open";
        upsert((await api(`/${t.id}`, "PATCH", { status, by: me.name, viewer: viewerId() })) as Thread);
        if (status === "resolved") {
          toast("Resolved");
          close();
        } else renderPopover();
        renderPanel();
        schedule();
      } else if (act === "edit" && commentId) {
        editing = commentId;
        renderPopover();
      } else if (act === "delete" && commentId) {
        if (!confirm("Delete this comment?")) return;
        const { thread } = (await api(`/${t.id}/${commentId}`, "DELETE", { secret: me.secret, viewer: viewerId() })) as { thread: Thread | null };
        if (thread) upsert(thread);
        else {
          threads.delete(t.id);
          close();
        }
        renderPopover();
        renderPanel();
        schedule();
      }
    } catch (err) {
      failed(err);
    }
  });

  // ---------- panel ----------
  function renderPanel() {
    const all = [...threads.values()].filter((t) => t.comments.length);
    const counts = { open: all.filter((t) => t.status === "open").length, resolved: all.filter((t) => t.status === "resolved").length };
    const badge = btn.querySelector<HTMLElement>(".badge")!;
    badge.textContent = String(counts.open);
    badge.hidden = !counts.open;
    btn.title = `Comment: click a frame or the canvas to leave a comment (M)${counts.open ? ` · ${counts.open} open` : ""}`;
    for (const b of panel.querySelectorAll<HTMLElement>("[data-filter]")) {
      const f = b.dataset.filter as Status;
      b.setAttribute("aria-pressed", String(f === filter));
      b.querySelector("span")!.textContent = String(counts[f]);
    }
    if (!on) return;
    const order = host.frameOrder();
    const rank = (t: Thread) => (t.frameId ? (order.includes(t.frameId) ? order.indexOf(t.frameId) : 1e6) : -1);
    const rows = all.filter((t) => t.status === filter).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    const cur = activeThread()?.id;
    list.innerHTML = rows.length
      ? rows.map((t) => {
          const first = t.comments[0];
          const n = t.comments.length - 1;
          return `<li><button data-open="${t.id}" aria-current="${t.id === cur}">${avatar(first)}<span class="txt">` +
            `<span class="meta"><b>${escapeHtml(first.authorName)}</b><time>${ago(t.comments.at(-1)!.createdAt)}</time></span>` +
            `<span class="excerpt">${escapeHtml(first.body)}</span>` +
            `<span class="where">${where(t, t)}${n ? ` · ${n} repl${n === 1 ? "y" : "ies"}` : ""}</span></span></button></li>`;
        }).join("")
      : `<li class="empty">${filter === "open"
          ? `No open comments. Click anything in a frame${coarse() ? "" : " (Option-click for its parent)"}, or the canvas beside a frame, to leave one.`
          : "Nothing resolved yet."}</li>`;
    const me = commenter();
    const meBtn = panel.querySelector<HTMLElement>("[data-act=rename]")!;
    meBtn.textContent = me.name;
    meBtn.style.color = authorColor(me.id);
  }

  panel.addEventListener("click", (e) => {
    const el = e.target as Element;
    const id = el.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (id) return focus(id);
    const f = el.closest<HTMLElement>("[data-filter]")?.dataset.filter as Status | undefined;
    if (f) {
      filter = f;
      if (activeThread() && activeThread()!.status !== f) close();
      renderPanel();
      return schedule();
    }
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") toggle(false);
    else if (act === "note") open({ draft: { frameId: null, elementId: null, x: null, y: null } });
    else if (act === "rename") rename(el.closest<HTMLElement>("[data-act]")!);
  });

  function rename(btnEl: HTMLElement) {
    const field = document.createElement("input");
    field.className = "rename";
    field.value = commenter().name;
    field.maxLength = 40;
    field.setAttribute("aria-label", "Your name on comments");
    btnEl.replaceWith(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) renameCommenter(field.value);
      field.replaceWith(btnEl);
      renderPanel();
      renderPopover();
    };
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    field.addEventListener("blur", () => finish(true));
  }

  /** Open a thread: show its pin (zooming to it) and the conversation. */
  function focus(id: string) {
    const t = threads.get(id);
    if (!t) return;
    if (!on) toggle(true);
    if (t.status !== filter) filter = t.status;
    open({ id });
    if (!t.frameId || !host.frameName(t.frameId)) return;
    host.select(t.frameId);
    history.replaceState(null, "", `/f/${host.fileId}/${t.frameId}?c=${t.id}`);
    const el = t.elementId ? host.primaryIframe(t.frameId)?.contentDocument?.querySelector(`[data-ds="${CSS.escape(t.elementId)}"]`) : null;
    if (el) {
      // scrollIntoView also scrolls the canvas page; undo that
      el.scrollIntoView({ block: "center", inline: "nearest" });
      viewport.scrollTop = viewport.scrollLeft = 0;
    }
    const a = anchorOf(t);
    if (a) {
      const pad = 140;
      const r = a.box ?? { x: a.x, y: a.y, w: 0, h: 0 };
      // leave room on the right for the thread
      host.revealScreenRect({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2 + (phone.matches ? 0 : 340), h: r.h + pad * 2 }, 1.25);
    }
    schedule();
  }

  pinsEl.addEventListener("click", (e) => {
    const key = (e.target as Element).closest<HTMLElement>("[data-thread]")?.dataset.thread;
    if (!key || key === "draft") return;
    if (activeThread()?.id === key) close();
    else open({ id: key });
  });

  // ---------- placing a comment ----------
  /** A click in a frame: on the element under it (the same one element select would take), at that spot. */
  function placeInFrame(frameId: string, iframe: HTMLIFrameElement, e: MouseEvent, el: Element | null) {
    if (el) {
      const r = el.getBoundingClientRect();
      const x = r.width ? (e.clientX - r.left) / r.width : 0.5;
      const y = r.height ? (e.clientY - r.top) / r.height : 0.5;
      open({ draft: { frameId, elementId: el.getAttribute("data-ds"), x: clamp(x, 0, 1), y: clamp(y, 0, 1) } });
    } else {
      open({ draft: { frameId, elementId: null, x: e.clientX / iframe.clientWidth, y: e.clientY / iframe.clientHeight } });
    }
  }
  /** A click on the canvas: pinned beside the nearest frame. */
  function placeOnCanvas(cx: number, cy: number) {
    let best: { id: string; r: DOMRect; d: number } | null = null;
    for (const id of host.frameOrder()) {
      const r = host.primaryIframe(id)?.getBoundingClientRect();
      if (!r) continue;
      const d = Math.hypot(Math.max(r.left - cx, 0, cx - r.right), Math.max(r.top - cy, 0, cy - r.bottom));
      if (!best || d < best.d) best = { id, r, d };
    }
    if (!best) return open({ draft: { frameId: null, elementId: null, x: null, y: null } });
    open({ draft: { frameId: best.id, elementId: null, x: (cx - best.r.left) / best.r.width, y: (cy - best.r.top) / best.r.height } });
  }
  // a click on empty canvas, not the end of a pan
  let down = { x: 0, y: 0 };
  viewport.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }), true);
  viewport.addEventListener("click", (e) => {
    if (!on || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const t = e.target as Element;
    if (t === viewport || t.id === "world" || t.closest(".frame-body")) {
      if (active && "draft" in active && input.value.trim()) return; // don't lose a half-written comment
      placeOnCanvas(e.clientX, e.clientY);
    }
  });

  // ---------- mode ----------
  function toggle(next = !on) {
    if (next === on) return;
    on = next;
    if (on) host.stopPicking();
    document.body.classList.toggle("commenting", on);
    btn.setAttribute("aria-pressed", String(on));
    $("#moveBtn").setAttribute("aria-pressed", String(!on && $("#pickBtn").getAttribute("aria-pressed") !== "true"));
    panel.hidden = !on;
    host.forEachDoc((doc) => doc.documentElement.toggleAttribute("data-ds-commenting", on));
    if (!on) {
      active = null;
      editing = null;
      formFor = "";
      pop.hidden = true;
      pinsEl.replaceChildren();
      pinEls.clear();
      if (location.search) history.replaceState(null, "", location.pathname + location.hash);
    }
    renderPanel();
    schedule();
  }
  btn.addEventListener("click", () => toggle());

  async function load() {
    try {
      const { threads: all } = (await api("")) as { threads: Thread[] };
      threads.clear();
      all.forEach(upsert);
    } catch {}
    renderPanel();
    renderPopover();
    schedule();
  }

  // relative times drift; refresh them now and then
  setInterval(() => on && (renderPanel(), active && renderPopover()), 60000);
  addEventListener("resize", schedule);

  return {
    on: () => on,
    toggle,
    load,
    schedule,
    placeInFrame,
    /** Esc: close the thread, then leave comment mode. */
    escape() {
      if (active) close();
      else if (on) toggle(false);
      else return false;
      return true;
    },
    /** A ?c=<thread> link: open comment mode on that thread once the frames are up. */
    initialFocus() {
      if (!wanted || !threads.has(wanted)) return false;
      const id = wanted;
      wanted = null;
      focus(id);
      return true;
    },
    onMessage(msg: { type: string; thread?: Thread; id?: string }) {
      if (msg.type === "thread" && msg.thread) upsert(msg.thread);
      else if (msg.type === "thread-deleted" && msg.id) {
        threads.delete(msg.id);
        if (activeThread() === null && active && "id" in active) close();
      } else return false;
      renderPanel();
      renderPopover();
      schedule();
      return true;
    },
  };
}
