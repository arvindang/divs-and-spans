import { $, copy, escapeHtml, prefs, rememberFile, toast, wireCopyButtons } from "./shared";

// ---------- types (mirror src/design-file.ts) ----------
interface FrameSummary {
  id: string;
  name: string;
  status: "working" | "ready";
  task: string | null;
  version: number;
  position: number;
  foundations: boolean;
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
/** Frame ids in canvas order; 0–9 select the first ten. */
let frameOrder: string[] = [];
let tokensVersion = 0;
const systemScheme: Scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let themeMode = prefs.get<ThemeMode>("theme", systemScheme);
let defaultWidth = prefs.get<number>("width", 1440);
let fullHeight = prefs.get<boolean>("fullHeight", false);
let picking = false;
let selectedFrame: string | null = initialFrameId || null;
type Target = { frameId: string; elementId: string };
/** Selected elements; the last one is the "current" one (URL hash, focus). */
let targets: Target[] = [];
let cam = { x: 80, y: 120, z: 0.5 };
let lastGoodCam = { ...cam };
let didInitialFocus = false;

const viewportHeightFor = (w: number) => (w <= 480 ? 844 : w <= 900 ? 1112 : 900);
const widthOf = (f: FrameSummary) => f.width ?? defaultWidth;
const schemes = (): Scheme[] => (themeMode === "both" ? ["light", "dark"] : [themeMode]);
const frameLink = (frameId: string, el?: string) => `${location.origin}/f/${fileId}/${frameId}${el ? `#${el}` : ""}`;

// ---------- camera ----------
function applyCamera() {
  // one NaN (e.g. from a bad gesture value) would otherwise stick forever, Fit included
  if ([cam.x, cam.y, cam.z].every(Number.isFinite)) lastGoodCam = { ...cam };
  else cam = { ...lastGoodCam };
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
  const padTop = 110;
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
    if (pinch) pinch.viaWheel = true;
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
  wheelLatch = { to: "canvas", t: performance.now() };
  onWheel(e);
}, { passive: false });

/**
 * Safari reports trackpad pinch as gesture* events, and zooms the whole page
 * unless they're cancelled — including when the pinch starts over a frame.
 * Turn them into canvas zoom, unless the same pinch is also arriving as
 * ctrl+wheel (then that path zooms and this one only cancels).
 */
type GestureLike = Event & { scale: number; clientX: number; clientY: number };
let pinch: { scale: number; viaWheel: boolean } | null = null;
function onGesture(e: GestureLike, at = { clientX: e.clientX, clientY: e.clientY }) {
  e.preventDefault();
  // Safari can report scale 0; dividing by it later is how the zoom became NaN
  if (e.type !== "gestureend" && !(e.scale > 0 && Number.isFinite(e.scale))) return;
  if (e.type === "gesturestart") pinch = { scale: 1, viaWheel: false };
  else if (e.type === "gestureend") pinch = null;
  else if (pinch) {
    // a real pinch moves a little per event; clamp so one odd value can't fling the zoom
    const step = Math.min(2, Math.max(0.5, e.scale / pinch.scale));
    if (!pinch.viaWheel) zoomAt(at.clientX, at.clientY, cam.z * step);
    pinch.scale = e.scale;
  }
}
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  addEventListener(type, (e) => onGesture(e as GestureLike), { passive: false });
}

/**
 * A wheel gesture sticks to whatever it started on until it pauses, so
 * scrolling a pane inside a frame never spills over into panning the canvas
 * (and a canvas pan never gets hijacked by a pane sliding under the cursor).
 */
const WHEEL_GESTURE_GAP_MS = 250;
let wheelLatch: { to: "canvas" | Element; t: number } | null = null;

/** Innermost element under the pointer that can scroll on the wheel's main axis. */
function scrollerFor(start: Element | null, win: Window, horizontal: boolean): Element | null {
  for (let el = start; el; el = el.parentElement) {
    const doc = el.ownerDocument;
    const root = el === doc.scrollingElement;
    const size = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (size <= 1) continue;
    if (root) return el;
    const style = win.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(horizontal ? style.overflowX : style.overflowY)) return el;
  }
  return null;
}

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
  else if ((e.key === "c" || e.key === "C") && (targets.length || selectedFrame)) copySelection();
  else if (e.key === "Escape") {
    if (targets.length) setTargets([], false);
    else if (picking) setPicking(false);
    else select(null);
    $("#connectPop").hidden = true;
  } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) fitAll();
  else if (e.key === ")" || (e.shiftKey && e.code === "Digit0")) zoomAt(innerWidth / 2, innerHeight / 2, 1);
  else if (e.key === "=" || e.key === "+") zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
  else if (e.key === "-") zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
  else if (e.key === "f" && selectedFrame) focusFrame(selectedFrame);
  else if (e.key === "h" || e.key === "H") setFullHeight(!fullHeight);
  else if (/^[0-9]$/.test(e.key) && frameOrder[+e.key]) selectAndReveal(frameOrder[+e.key]);
  else if (e.key === "Tab" && frameOrder.length) {
    const i = selectedFrame ? frameOrder.indexOf(selectedFrame) : -1;
    const n = frameOrder.length;
    selectAndReveal(frameOrder[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n]);
  }  else return;
  e.preventDefault();
}
addEventListener("keydown", (e) => onKey(e, true));
addEventListener("keyup", (e) => onKey(e, false));
addEventListener("blur", () => {
  spaceDown = false;
  viewport.classList.remove("space");
});

// ---------- selection & picking ----------
/** Select a frame from the keyboard, panning it into view if it's off screen. */
function selectAndReveal(id: string) {
  select(id);
  const r = frameEls.get(id)!.getBoundingClientRect();
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const xOk = r.left >= 0 && r.right <= vw;
  const yOk = r.top >= 90 && r.top < vh * 0.8; // label clears the toolbar
  if (xOk && yOk) return;
  if (!xOk) cam.x += r.width > vw - 80 ? 40 - r.left : vw / 2 - (r.left + r.width / 2);
  if (!yOk) cam.y += 110 - r.top;
  applyCamera();
}
function select(id: string | null) {
  selectedFrame = id;
  for (const [fid, el] of frameEls) el.classList.toggle("selected", fid === id);
  const path = id ? `/f/${fileId}/${id}` : `/f/${fileId}`;
  if (location.pathname !== path) history.replaceState(null, "", path + (id && hashFor(id) ? `#${hashFor(id)}` : ""));
}

function setPicking(on: boolean) {
  picking = on;
  $("#pickBtn").setAttribute("aria-pressed", String(on));
  forEachDoc((doc) => {
    doc.documentElement.toggleAttribute("data-ds-picking", on);
    if (on) doc.getSelection()?.removeAllRanges();
    else doc.querySelectorAll("[data-ds-hover]").forEach((n) => n.removeAttribute("data-ds-hover"));
  });
  renderPickBar();
}
/** Stays up while selecting: how many are selected and the keys that apply. */
function renderPickBar() {
  const bar = $("#pickBar");
  bar.hidden = !picking;
  document.body.classList.toggle("picking", picking);
  if (!picking) return;
  const n = targets.length;
  const hints = [
    n ? "<kbd>C</kbd> copy link" : "",
    `<kbd>⇧</kbd> click to ${n ? "add or remove" : "select several"}`,
    "<kbd>⌥</kbd> click for parent",
    `<kbd>Esc</kbd> ${n ? "clear" : "done"}`,
  ].filter(Boolean);
  bar.innerHTML = `<b>${n ? `${n} selected` : "Click an element to select it"}</b>${hints.map((h) => `<span>${h}</span>`).join("")}`;
}
/** The selected elements in one frame, as a link hash: a,b,c */
const hashFor = (frameId: string) => targets.filter((t) => t.frameId === frameId).map((t) => t.elementId).join(",");
/** C: copy the selected elements' link (one per frame), or the selected frame's if none. */
function copySelection() {
  if (targets.length) {
    const frameIds = [...new Set(targets.map((t) => t.frameId))];
    const n = targets.length;
    copy(frameIds.map((fid) => frameLink(fid, hashFor(fid))).join("\n"),
      `Copied ${frameIds.length === 1 ? "link" : `${frameIds.length} links`} to ${n} element${n === 1 ? "" : "s"}`);
  } else if (selectedFrame) copy(frameLink(selectedFrame), "Copied frame link");
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
html { overscroll-behavior: none; }
html[data-ds-picking] * { cursor: crosshair !important; -webkit-user-select: none !important; user-select: none !important; }
[data-ds-hover] { outline: 2px solid #6d5dfc !important; outline-offset: -1px !important; }
[data-ds-target] { outline: 2px solid #f59e0b !important; outline-offset: 2px !important; }
[data-ds-target] [data-ds]:not([data-ds-hover]) { outline: 1px dashed rgb(245 158 11 / 0.45) !important; outline-offset: -1px !important; }
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
    const zoom = e.ctrlKey || e.metaKey;
    if (!zoom) {
      const now = performance.now();
      if (!wheelLatch || now - wheelLatch.t > WHEEL_GESTURE_GAP_MS) {
        const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        wheelLatch = { to: scrollerFor(e.target as Element, win, horizontal) ?? "canvas", t: now };
      }
      wheelLatch.t = now;
      const latched = wheelLatch.to;
      if (latched !== "canvas") {
        // the pane under the pointer scrolls natively; nothing reaches the canvas
        if (latched.contains(e.target as Node)) return;
        // pointer drifted off the pane mid-gesture: keep scrolling it
        e.preventDefault();
        const k = e.deltaMode === 1 ? 16 : 1;
        latched.scrollBy(e.deltaX * k, e.deltaY * k);
        return;
      }
    }
    e.preventDefault();
    const p = toParent(e);
    onWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, ...p });
  }, { passive: false });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    doc.addEventListener(type, (e) => onGesture(e as GestureLike, toParent(e as GestureLike & MouseEvent)), { passive: false });
  }
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
  // no text selection (drag or Shift-click) while selecting elements
  doc.addEventListener("mousedown", (e) => picking && e.preventDefault(), true);
  doc.addEventListener("click", (e) => {
    e.preventDefault(); // designs are static: links and buttons never navigate
    if (!picking) return;
    const el = pickable(e.target, e.altKey);
    if (!el) return;
    const t = { frameId, elementId: el.getAttribute("data-ds")! };
    if (!e.shiftKey) {
      setTargets([t], false);
      copy(frameLink(frameId, t.elementId), `Copied link to ${describe(el)}`);
      return;
    }
    // Shift-click toggles; a selected container already includes everything inside it
    const elOf = (x: Target) => (x.frameId === frameId ? doc.querySelector(`[data-ds="${CSS.escape(x.elementId)}"]`) : null);
    let next: Target[];
    if (targets.some((x) => elOf(x) === el)) next = targets.filter((x) => elOf(x) !== el);
    else {
      const covering = targets.map(elOf).find((p) => p?.contains(el));
      if (covering) return void toast(`Already included in ${describe(covering)}`);
      next = [...targets.filter((x) => !el.contains(elOf(x))), t];
    }
    setTargets(next, false);
    if (!next.length) return void toast("Selection cleared");
    copySelection();
  }, true);
  doc.addEventListener("submit", (e) => e.preventDefault(), true);

  markTargets(doc, frameId);
}

/** Outline this frame's selected elements; returns the current (last) one if it's here. */
function markTargets(doc: Document, frameId: string) {
  doc.querySelectorAll("[data-ds-target]").forEach((n) => n.removeAttribute("data-ds-target"));
  let current: Element | null = null;
  for (const t of targets) {
    if (t.frameId !== frameId) continue;
    const el = doc.querySelector(`[data-ds="${CSS.escape(t.elementId)}"]`);
    el?.setAttribute("data-ds-target", "");
    if (t === targets.at(-1)) current = el;
  }
  return current;
}

function setTargets(ts: Target[], focus: boolean) {
  targets = ts;
  renderPickBar();
  const t = ts.at(-1);
  if (t) select(t.frameId);
  history.replaceState(null, "", `/f/${fileId}${t ? `/${t.frameId}#${hashFor(t.frameId)}` : selectedFrame ? `/${selectedFrame}` : ""}`);
  let found: { el: Element; iframe: HTMLIFrameElement } | null = null;
  forEachDoc((doc, fid, iframe) => {
    const el = markTargets(doc, fid);
    if (el && !found) found = { el, iframe };
  });
  if (focus && found) {
    const { el, iframe } = found as { el: Element; iframe: HTMLIFrameElement };
    // bring it into view inside the frame; scrollIntoView also scrolls the canvas page, so undo that
    el.scrollIntoView({ block: "center", inline: "nearest" });
    viewport.scrollTop = viewport.scrollLeft = 0;
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
      <kbd class="key"></kbd><span class="name"></span><span class="meta"></span>
      <button class="copy" title="Copy frame link (C when selected)">Copy link <kbd>C</kbd></button>
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
  // allow-scripts only so Safari runs the listeners instrument() attaches; the
  // render's CSP (script-src 'none') still blocks every script the frame carries.
  // Still no forms, popups or top navigation.
  next.setAttribute("sandbox", "allow-same-origin allow-scripts");
  next.setAttribute("loading", "eager");
  next.title = `${f.name} (${scheme})`;
  next.dataset.src = src;
  next.dataset.loading = "";
  next.style.cssText = `position:absolute;inset:0 auto auto 0;width:${width}px;height:${vh}px;opacity:0;color-scheme:${scheme}`;
  next.addEventListener("load", () => {
    const h = frameHeight(next, width);
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

/** Screen mode shows one device viewport and the document scrolls inside; full height grows to the content. */
function frameHeight(iframe: HTMLIFrameElement, width: number) {
  const vh = viewportHeightFor(width);
  if (!fullHeight) return vh;
  iframe.style.height = `${vh}px`; // measure at device height so 100vh layouts don't feed back
  return Math.min(12000, Math.max(vh, iframe.contentDocument?.documentElement.scrollHeight ?? vh));
}

/** Resize loaded frames in place (width or height mode changed) without reloading them. */
function resizeScreens() {
  for (const [id, el] of frameEls) {
    const f = frames.get(id);
    if (!f) continue;
    const width = widthOf(f);
    for (const screen of el.querySelectorAll<HTMLElement>(".screen")) {
      screen.style.width = `${width}px`;
      const iframe = screen.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
      if (!iframe) {
        screen.style.height = `${viewportHeightFor(width)}px`;
        continue;
      }
      iframe.style.width = `${width}px`;
      const h = frameHeight(iframe, width);
      iframe.style.height = screen.style.height = `${h}px`;
    }
    syncPairHeights(id);
  }
}

function setFullHeight(on: boolean) {
  fullHeight = on;
  prefs.set("fullHeight", on);
  $("#fullBtn").setAttribute("aria-pressed", String(on));
  resizeScreens();
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
  const ordered = [...frames.values()].sort(
    (a, b) => Number(b.foundations) - Number(a.foundations) || a.position - b.position,
  );
  for (const f of ordered) renderFrame(f);
  frameOrder = ordered.map((f) => f.id);
  frameOrder.forEach((id, i) => {
    const key = frameEls.get(id)!.querySelector<HTMLElement>(".key")!;
    key.textContent = i < 10 ? String(i) : "";
    key.title = i < 10 ? `Press ${i} to select` : "";
  });
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
    if (hash) setTargets(hash.split(",").map((elementId) => ({ frameId: initialFrameId, elementId })), true);
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
  renderAll();
  resizeScreens();
});
$("#fullBtn").setAttribute("aria-pressed", String(fullHeight));
$("#fullBtn").addEventListener("click", () => setFullHeight(!fullHeight));
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
  if (id && fid) setTargets(id.split(",").map((elementId) => ({ frameId: fid, elementId })), true);
});

applyCamera();
load().then(connect);
