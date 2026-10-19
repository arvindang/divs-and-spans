import { $, copy, escapeHtml, prefs, rememberFile, toast, wireCopyButtons } from "./shared";

// ---------- types (mirror src/design-file.ts) ----------
interface FrameSummary {
  id: string;
  name: string;
  status: "working" | "ready";
  task: string | null;
  version: number;
  position: number;
  width: number | null;
  hasContent: boolean;
  lockExpiresAt: number | null;
  updatedAt: number;
}
interface FileState {
  id: string;
  name: string;
  tokensVersion: number;
  frames: FrameSummary[];
}
type Scheme = "light" | "dark";
type ThemeMode = Scheme | "both";

// ---------- state ----------
const [, , fileId, initialFrameId] = location.pathname.split("/");
const viewport = $("#viewport");
const world = $("#world");

let file: FileState | null = null;
const frames = new Map<string, FrameSummary>();
const frameEls = new Map<string, HTMLElement>();
let tokensVersion = 0;
const systemScheme: Scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let themeMode = prefs.get<ThemeMode>("theme", systemScheme);
let defaultWidth = prefs.get<number>("width", 1440);
let picking = false;
let selectedFrame: string | null = initialFrameId || null;
let target: { frameId: string; elementId: string } | null = null;
let cam = { x: 80, y: 120, z: 0.5 };
let didInitialFocus = false;

const viewportHeightFor = (w: number) => (w <= 480 ? 844 : w <= 900 ? 1112 : 900);
const widthOf = (f: FrameSummary) => f.width ?? defaultWidth;
const schemes = (): Scheme[] => (themeMode === "both" ? ["light", "dark"] : [themeMode]);
const frameLink = (frameId: string, el?: string) => `${location.origin}/f/${fileId}/${frameId}${el ? `#${el}` : ""}`;

// ---------- camera ----------
function applyCamera() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  viewport.style.setProperty("--z", String(cam.z));
  viewport.style.setProperty("--bx", `${cam.x}px`);
  viewport.style.setProperty("--by", `${cam.y}px`);
  $("#zoomLabel").textContent = `${Math.round(cam.z * 100)}%`;
  viewport.classList.toggle("tiny", cam.z < 0.3);
}
function zoomAt(clientX: number, clientY: number, nextZ: number) {
  const z = Math.min(4, Math.max(0.05, nextZ));
  const wx = (clientX - cam.x) / cam.z;
  const wy = (clientY - cam.y) / cam.z;
  cam = { x: clientX - wx * z, y: clientY - wy * z, z };
  applyCamera();
}
/** Fit a world-space rect into the viewport. */
function fitRect(r: { x: number; y: number; w: number; h: number }, maxZ = 1) {
  const padX = Math.min(80, viewport.clientWidth * 0.05);
  const padTop = viewport.clientWidth < 720 ? 130 : 110;
  const padBottom = 60;
  const vw = viewport.clientWidth - padX * 2;
  const vh = viewport.clientHeight - padTop - padBottom;
  const z = Math.min(maxZ, vw / r.w, vh / r.h);
  cam = {
    z,
    x: padX + (vw - r.w * z) / 2 - r.x * z,
    y: padTop + Math.max(0, (vh - r.h * z) / 2) - r.y * z,
  };
  applyCamera();
}
const worldRectOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: (r.left - cam.x) / cam.z, y: (r.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z };
};
function fitAll() {
  if (!frames.size) return;
  fitRect({ x: 0, y: 0, w: world.offsetWidth, h: world.offsetHeight });
}
function focusFrame(id: string) {
  const el = frameEls.get(id);
  if (el) fitRect(worldRectOf(el));
}

// wheel: trackpad scroll pans, pinch / ctrl+wheel zooms
function onWheel(e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; clientX: number; clientY: number }) {
  const scale = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-e.deltaY * scale * 0.01));
  } else {
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    cam.x -= dx * scale;
    cam.y -= dy * scale;
    applyCamera();
  }
}
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  onWheel(e);
}, { passive: false });

// drag to pan: on empty canvas, with space held, or middle mouse
let spaceDown = false;
let drag: { x: number; y: number; cx: number; cy: number; id: number } | null = null;
viewport.addEventListener("pointerdown", (e) => {
  const onEmpty = e.target === viewport || e.target === world;
  if (e.button === 1 || spaceDown || (e.button === 0 && onEmpty)) {
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, id: e.pointerId };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
    if (onEmpty && !spaceDown) select(null);
  }
});
viewport.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  cam.x = drag.cx + (e.clientX - drag.x);
  cam.y = drag.cy + (e.clientY - drag.y);
  applyCamera();
});
const endDrag = () => {
  drag = null;
  viewport.classList.remove("panning");
};
viewport.addEventListener("pointerup", endDrag);
viewport.addEventListener("pointercancel", endDrag);

// ---------- keyboard ----------
function onKey(e: KeyboardEvent, down: boolean) {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.code === "Space") {
    spaceDown = down;
    viewport.classList.toggle("space", down);
    e.preventDefault();
    return;
  }
  if (!down || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "l" || e.key === "L") setPicking(!picking);
  else if (e.key === "Escape") {
    if (picking) setPicking(false);
    else select(null);
    $("#connectPop").hidden = true;
  } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) fitAll();
  else if (e.key === ")" || (e.shiftKey && e.code === "Digit0")) zoomAt(innerWidth / 2, innerHeight / 2, 1);
  else if (e.key === "=" || e.key === "+") zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
  else if (e.key === "-") zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
  else if (e.key === "f" && selectedFrame) focusFrame(selectedFrame);
  else return;
  e.preventDefault();
}
addEventListener("keydown", (e) => onKey(e, true));
addEventListener("keyup", (e) => onKey(e, false));
addEventListener("blur", () => {
  spaceDown = false;
  viewport.classList.remove("space");
});

// ---------- selection & picking ----------
function select(id: string | null) {
  selectedFrame = id;
  for (const [fid, el] of frameEls) el.classList.toggle("selected", fid === id);
  const path = id ? `/f/${fileId}/${id}` : `/f/${fileId}`;
  if (location.pathname !== path) history.replaceState(null, "", path + (target && target.frameId === id ? `#${target.elementId}` : ""));
}

function setPicking(on: boolean) {
  picking = on;
  $("#pickBtn").setAttribute("aria-pressed", String(on));
  forEachDoc((doc) => {
    doc.documentElement.toggleAttribute("data-ds-picking", on);
    if (!on) doc.querySelectorAll("[data-ds-hover]").forEach((n) => n.removeAttribute("data-ds-hover"));
  });
  if (on) toast("Click any element to copy its link · Option-click for its parent · Esc to stop", 3200);
}
$("#pickBtn").addEventListener("click", () => setPicking(!picking));

function forEachDoc(fn: (doc: Document, frameId: string, iframe: HTMLIFrameElement) => void) {
  for (const [fid, el] of frameEls) {
    el.querySelectorAll("iframe").forEach((ifr) => {
      const doc = ifr.contentDocument;
      if (doc?.documentElement) fn(doc, fid, ifr);
    });
  }
}

const PICK_CSS = `
html[data-ds-picking] * { cursor: crosshair !important; }
[data-ds-hover] { outline: 2px solid #6d5dfc !important; outline-offset: -1px !important; }
[data-ds-target] { outline: 2px solid #f59e0b !important; outline-offset: 2px !important; }
`;

function describe(el: Element) {
  const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
  return `${el.tagName.toLowerCase()}${cls.length ? "." + cls.join(".") : ""}`;
}

/** Wire an iframe's document into the canvas: wheel/keys forward, links don't navigate, picking. */
function instrument(iframe: HTMLIFrameElement, frameId: string) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return;
  const style = doc.createElement("style");
  style.setAttribute("data-ds-canvas", "");
  style.textContent = PICK_CSS;
  (doc.head || doc.documentElement).append(style);
  doc.documentElement.toggleAttribute("data-ds-picking", picking);

  const toParent = (e: MouseEvent | WheelEvent) => {
    const r = iframe.getBoundingClientRect();
    const k = r.width / iframe.clientWidth;
    return { clientX: r.left + e.clientX * k, clientY: r.top + e.clientY * k };
  };
  doc.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = toParent(e);
    onWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, ...p });
  }, { passive: false });
  doc.addEventListener("keydown", (e) => onKey(e, true));
  doc.addEventListener("keyup", (e) => onKey(e, false));
  doc.addEventListener("pointerdown", () => {
    if (selectedFrame !== frameId) select(frameId);
  });

  const pickable = (t: EventTarget | null, parent: boolean) => {
    let el = (t as Element | null)?.closest?.("[data-ds]") ?? null;
    if (el && parent) el = el.parentElement?.closest("[data-ds]") ?? el;
    return el;
  };
  let hovered: Element | null = null;
  doc.addEventListener("mouseover", (e) => {
    if (!picking) return;
    hovered?.removeAttribute("data-ds-hover");
    hovered = pickable(e.target, e.altKey);
    hovered?.setAttribute("data-ds-hover", "");
  });
  doc.addEventListener("mouseleave", () => hovered?.removeAttribute("data-ds-hover"));
  doc.addEventListener("click", (e) => {
    e.preventDefault(); // designs are static: links and buttons never navigate
    if (!picking) return;
    const el = pickable(e.target, e.altKey);
    if (!el) return;
    const id = el.getAttribute("data-ds")!;
    setTarget({ frameId, elementId: id }, false);
    copy(frameLink(frameId, id), `Copied link to ${describe(el)}`);
  }, true);
  doc.addEventListener("submit", (e) => e.preventDefault(), true);

  if (target?.frameId === frameId) markTarget(doc);
}

function markTarget(doc: Document) {
  doc.querySelectorAll("[data-ds-target]").forEach((n) => n.removeAttribute("data-ds-target"));
  if (!target) return null;
  const el = doc.querySelector(`[data-ds="${CSS.escape(target.elementId)}"]`);
  el?.setAttribute("data-ds-target", "");
  return el;
}

function setTarget(t: typeof target, focus: boolean) {
  target = t;
  if (t) select(t.frameId);
  history.replaceState(null, "", `/f/${fileId}${t ? `/${t.frameId}#${t.elementId}` : selectedFrame ? `/${selectedFrame}` : ""}`);
  let found: { el: Element; iframe: HTMLIFrameElement } | null = null;
  forEachDoc((doc, fid, iframe) => {
    const el = fid === t?.frameId ? markTarget(doc) : (doc.querySelectorAll("[data-ds-target]").forEach((n) => n.removeAttribute("data-ds-target")), null);
    if (el && !found) found = { el, iframe };
  });
  if (focus && found) {
    const { el, iframe } = found as { el: Element; iframe: HTMLIFrameElement };
    const fr = worldRectOf(iframe);
    const er = el.getBoundingClientRect();
    const pad = 120;
    fitRect({ x: fr.x + er.left - pad, y: fr.y + er.top - pad, w: er.width + pad * 2, h: er.height + pad * 2 }, 1.25);
  }
}

// ---------- rendering ----------
function frameSrc(f: FrameSummary, scheme: Scheme) {
  return `/api/files/${fileId}/frames/${f.id}/render?theme=${scheme}&v=${f.version}&t=${tokensVersion}`;
}

function buildFrameEl(f: FrameSummary) {
  const el = document.createElement("div");
  el.className = "frame";
  el.dataset.id = f.id;
  el.innerHTML = `
    <div class="frame-label">
      <span class="name"></span><span class="meta"></span>
      <button class="copy" title="Copy frame link">Copy link</button>
    </div>
    <div class="frame-body"></div>`;
  el.querySelector(".copy")!.addEventListener("click", (e) => {
    e.stopPropagation();
    copy(frameLink(f.id), "Copied frame link");
  });
  el.querySelector(".frame-label")!.addEventListener("click", () => select(f.id));
  el.querySelector(".frame-label")!.addEventListener("dblclick", () => focusFrame(f.id));
  return el;
}

function buildScreen(scheme: Scheme) {
  const s = document.createElement("div");
  s.className = "screen";
  s.dataset.scheme = scheme;
  s.innerHTML = `
    <div class="working-overlay">
      <div class="skeleton"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="task"><span class="pulse"></span><span class="task-text"></span></div>
    </div>
    <div class="scheme">${scheme}</div>`;
  return s;
}

/** Load a new render behind the current one and swap on load, so updates don't flash. */
function loadInto(screen: HTMLElement, f: FrameSummary, scheme: Scheme, width: number) {
  const src = frameSrc(f, scheme);
  const current = screen.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
  if (current?.dataset.src === src) return;
  screen.querySelectorAll("iframe[data-loading]").forEach((n) => n.remove());

  const vh = viewportHeightFor(width);
  const next = document.createElement("iframe");
  next.setAttribute("sandbox", "allow-same-origin"); // no scripts, no forms, no navigation
  next.setAttribute("loading", "eager");
  next.title = `${f.name} (${scheme})`;
  next.dataset.src = src;
  next.dataset.loading = "";
  next.style.cssText = `position:absolute;inset:0 auto auto 0;width:${width}px;height:${vh}px;opacity:0;color-scheme:${scheme}`;
  next.addEventListener("load", () => {
    const doc = next.contentDocument;
    const h = Math.min(12000, Math.max(vh, doc?.documentElement.scrollHeight ?? vh));
    next.style.cssText = `width:${width}px;height:${h}px;color-scheme:${scheme}`;
    delete next.dataset.loading;
    current?.remove();
    screen.style.height = `${h}px`;
    // never move a loaded iframe in the DOM: that reloads it and drops instrumentation
    instrument(next, f.id);
    syncPairHeights(f.id);
    maybeInitialFocus();
  }, { once: true });
  next.src = src;
  screen.prepend(next);
}

/** In "both" mode keep light and dark screens the same height. */
function syncPairHeights(frameId: string) {
  const el = frameEls.get(frameId);
  if (!el) return;
  const screens = [...el.querySelectorAll<HTMLElement>(".screen")];
  const h = Math.max(...screens.map((s) => parseFloat(s.style.height) || 0));
  for (const s of screens) {
    s.style.height = `${h}px`;
    const ifr = s.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
    if (ifr) ifr.style.height = `${h}px`;
  }
}

function renderFrame(f: FrameSummary) {
  let el = frameEls.get(f.id);
  if (!el) {
    el = buildFrameEl(f);
    frameEls.set(f.id, el);
  }
  const width = widthOf(f);
  const working = f.status === "working" && (!f.lockExpiresAt || f.lockExpiresAt > Date.now());
  el.classList.toggle("working", working);
  el.classList.toggle("has-content", f.hasContent);
  el.classList.toggle("selected", selectedFrame === f.id);
  el.querySelector(".name")!.textContent = f.name;
  el.querySelector(".meta")!.textContent = `${f.version ? `v${f.version}` : "new"} · ${width}px`;

  const body = el.querySelector<HTMLElement>(".frame-body")!;
  const wanted = schemes();
  [...body.children].forEach((c) => {
    if (!wanted.includes((c as HTMLElement).dataset.scheme as Scheme)) c.remove();
  });
  for (const scheme of wanted) {
    let screen = body.querySelector<HTMLElement>(`.screen[data-scheme="${scheme}"]`);
    if (!screen) {
      screen = buildScreen(scheme);
      // light before dark
      if (scheme === "light") body.prepend(screen);
      else body.append(screen);
    }
    screen.style.width = `${width}px`;
    if (!screen.style.height) screen.style.height = `${viewportHeightFor(width)}px`;
    screen.querySelector(".task-text")!.textContent = f.task ? `Working · ${f.task}` : "Working…";
    screen.querySelector<HTMLElement>(".scheme")!.style.display = themeMode === "both" ? "" : "none";
    if (f.hasContent) loadInto(screen, f, scheme, width);
    else screen.querySelectorAll("iframe").forEach((n) => n.remove());
  }
}

/**
 * Put children in order, moving only what's out of place. Moving an iframe
 * (or any ancestor) in the DOM reloads it, so blind re-appends cause flicker.
 */
function placeInOrder(parent: HTMLElement, wanted: HTMLElement[]) {
  wanted.forEach((el, i) => {
    const at = parent.children[i];
    if (at === el) return;
    if (el.parentElement === parent && i === wanted.length - 1 && !el.nextElementSibling) return;
    parent.insertBefore(el, at ?? null);
  });
}

function renderAll() {
  const ordered = [...frames.values()].sort((a, b) => a.position - b.position);
  for (const f of ordered) renderFrame(f);
  for (const [id, el] of frameEls) {
    if (!frames.has(id)) {
      el.remove();
      frameEls.delete(id);
    }
  }
  placeInOrder(world, ordered.map((f) => frameEls.get(f.id)!));
  $("#empty").hidden = frames.size > 0;
  for (const btn of document.querySelectorAll<HTMLElement>("[data-theme-mode]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeMode === themeMode));
  }
  maybeInitialFocus();
}

function maybeInitialFocus() {
  if (didInitialFocus || !frames.size) return;
  // wait until frames with content have rendered once so sizes are real
  const pending = [...frameEls.values()].some((el) => el.querySelector("iframe[data-loading]"));
  if (pending) return;
  didInitialFocus = true;
  const hash = location.hash.slice(1);
  if (initialFrameId && frames.has(initialFrameId)) {
    if (hash) setTarget({ frameId: initialFrameId, elementId: hash }, true);
    else focusFrame(initialFrameId);
  } else fitAll();
}

// ---------- controls ----------
for (const btn of document.querySelectorAll<HTMLElement>("[data-theme-mode]")) {
  btn.addEventListener("click", () => {
    themeMode = btn.dataset.themeMode as ThemeMode;
    prefs.set("theme", themeMode);
    renderAll();
  });
}
const widthSel = $("#widthSel") as HTMLSelectElement;
widthSel.value = String(defaultWidth);
widthSel.addEventListener("change", () => {
  defaultWidth = Number(widthSel.value);
  prefs.set("width", defaultWidth);
  for (const el of frameEls.values()) el.querySelectorAll<HTMLElement>(".screen").forEach((s) => (s.style.height = ""));
  renderAll();
});
$("#fitBtn").addEventListener("click", fitAll);
$("#zoomLabel").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1));

const nameInput = $("#fileName") as HTMLInputElement;
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
});
nameInput.addEventListener("change", async () => {
  const name = nameInput.value.trim() || "Untitled";
  await fetch(`/api/files/${fileId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  rememberFile(fileId, name);
  document.title = `${name} · Divs & Spans`;
});

// connect popover
const pop = $("#connectPop");
const togglePop = () => (pop.hidden = !pop.hidden);
$("#connectBtn").addEventListener("click", togglePop);
$("#emptyConnect").addEventListener("click", togglePop);
($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
($("#fileUrl") as HTMLInputElement).value = `${location.origin}/f/${fileId}`;
($("#tokensLink") as HTMLAnchorElement).href = `/api/files/${fileId}/tokens.css`;
$("#promptEx").textContent = `${location.origin}/f/${fileId}\nDesign the home screen for …`;
wireCopyButtons();

// ---------- live sync ----------
let ws: WebSocket | null = null;
let retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/files/${fileId}/ws`);
  ws.addEventListener("open", () => {
    retry = 0;
    setLive(true);
    load(); // resync anything missed while disconnected
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "frame") {
      frames.set(msg.frame.id, msg.frame);
      renderAll();
    } else if (msg.type === "frame-deleted") {
      frames.delete(msg.id);
      renderAll();
    } else if (msg.type === "tokens") {
      tokensVersion = msg.version;
      renderAll();
    } else if (msg.type === "file") {
      setName(msg.name);
    }
  });
  ws.addEventListener("close", () => {
    setLive(false);
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  });
}
setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
// claims expire server-side; re-render so an abandoned frame stops shimmering
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const f of frames.values()) {
    if (f.status === "working" && f.lockExpiresAt && f.lockExpiresAt < now) {
      f.status = "ready";
      changed = true;
    }
  }
  if (changed) renderAll();
}, 10000);

function setLive(on: boolean) {
  const dot = $("#liveDot");
  dot.classList.toggle("live", on);
  dot.title = on ? "Live" : "Reconnecting…";
}
function setName(name: string) {
  if (document.activeElement !== nameInput) nameInput.value = name;
  document.title = `${name} · Divs & Spans`;
}

async function load() {
  const res = await fetch(`/api/files/${fileId}`);
  if (res.status === 404) {
    document.body.innerHTML = `<main class="home"><div class="home-card"><h1>File not found</h1><p>This link doesn't point to a design file. <a href="/">Create one</a>.</p></div></main>`;
    ws?.close();
    return;
  }
  file = (await res.json()) as FileState;
  tokensVersion = file.tokensVersion;
  frames.clear();
  for (const f of file.frames) frames.set(f.id, f);
  setName(file.name);
  rememberFile(file.id, file.name);
  renderAll();
}

addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  const fid = location.pathname.split("/")[3] || selectedFrame;
  if (id && fid) setTarget({ frameId: fid, elementId: id }, true);
});

applyCamera();
load().then(connect);
