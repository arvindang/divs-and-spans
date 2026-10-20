import { $, copy, escapeHtml, prefs, rememberFile, toast, wireCopyButtons } from "./shared";
import { linksIn, resolveLink } from "../src/flows";
import { DEFAULT_BY_KIND, DEVICES, customDevice, deviceById, deviceForLegacyWidth, kindForWidth, type CustomSize, type Device, type DeviceKind } from "./devices";

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
const legacyWidth = prefs.get<number | null>("width", null);
/** Each file remembers its own device; a file you haven't picked one for starts from what its frames are pinned to. */
const fileDevice = prefs.get<string | null>(`device:${fileId}`, null);
let deviceChosen = fileDevice !== null;
let deviceId = fileDevice ?? prefs.get<string>("device", legacyWidth ? deviceForLegacyWidth(legacyWidth) : DEFAULT_BY_KIND.desktop);
let custom = prefs.get<CustomSize | null>("custom", null);
if (!deviceById(deviceId) && !(deviceId === "custom" && custom)) deviceId = DEFAULT_BY_KIND.desktop;
let showChrome = prefs.get<boolean>("chrome", false);
let fullHeight = prefs.get<boolean>("fullHeight", false);
let picking = false;
let flowsAll = prefs.get<boolean>("flowsAll", false);
let selectedFrame: string | null = initialFrameId || null;
type Target = { frameId: string; elementId: string };
/** Selected elements; the last one is the "current" one (URL hash, focus). */
let targets: Target[] = [];
let cam = { x: 80, y: 120, z: 0.5 };
let lastGoodCam = { ...cam };
let didInitialFocus = false;

/**
 * Every frame previews on the chosen device, like Safari's responsive design
 * mode. A frame's own width only tells the agent and the lint it's device-specific.
 */
const currentDevice = (): Device => (deviceId === "custom" && custom ? customDevice(custom) : deviceById(deviceId)!);
function saveDevice() {
  deviceChosen = true;
  prefs.set("device", deviceId);
  prefs.set(`device:${fileId}`, deviceId);
}
/** For a file with no device picked yet: the kind most of its frames are pinned to. */
function deviceFromPins(fs: FrameSummary[]) {
  const kinds = fs.filter((f) => f.width && !f.foundations).map((f) => kindForWidth(f.width!));
  if (!kinds.length) return;
  const top = (["phone", "tablet", "desktop"] as DeviceKind[]).sort((a, b) => kinds.filter((k) => k === b).length - kinds.filter((k) => k === a).length)[0];
  deviceId = DEFAULT_BY_KIND[top];
  deviceSel.value = deviceId;
}
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
  scheduleFlows();
}
function zoomAt(clientX: number, clientY: number, nextZ: number) {
  const z = Math.min(4, Math.max(0.05, nextZ));
  const wx = (clientX - cam.x) / cam.z;
  const wy = (clientY - cam.y) / cam.z;
  cam = { x: clientX - wx * z, y: clientY - wy * z, z };
  applyCamera();
}
/** Phones get the dock at the bottom and the view sheet; mirrors the CSS breakpoint. */
const phone = matchMedia("(max-width: 820px)");
const coarse = matchMedia("(pointer: coarse)");

/** Fit a world-space rect into the viewport. */
function fitRect(r: { x: number; y: number; w: number; h: number }, maxZ = 1) {
  const padX = Math.min(80, viewport.clientWidth * 0.05);
  // clear the bar plus a frame label on top, and the dock on phones
  const padTop = phone.matches ? $(".bar").getBoundingClientRect().bottom + 40 : 110;
  const padBottom = phone.matches ? innerHeight - $("#tools").getBoundingClientRect().top + 16 : 60;
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
  // a touch pinch on the canvas is already zooming through pointer events
  if (touches.size) return;
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

// drag to pan: on empty canvas, with space held, or middle mouse; with Move, one finger anywhere
let spaceDown = false;
let drag: { x: number; y: number; cx: number; cy: number; id: number } | null = null;
/** Fingers on the canvas; two pinch-zoom around their midpoint and pan with it. */
const touches = new Map<number, { x: number; y: number }>();
let touchPinch: { d: number; x: number; y: number } | null = null;
/** A touch that moved is a pan, not a tap: swallow the click it would end in. */
let touchMoved = false;
let swallowClicksUntil = 0;
let touchStart = { x: 0, y: 0 };
const TAP_SLOP = 8;
const pinchOf = () => {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};
const startDrag = (e: PointerEvent) => {
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, id: e.pointerId };
  viewport.classList.add("panning");
};
viewport.addEventListener("pointerdown", (e) => {
  closeViewSheet();
  const onEmpty = e.target === viewport || e.target === world;
  if (e.pointerType === "touch") {
    // flow lines and resize handles keep their own touches
    if ((e.target as Element).closest(".hit, .resize")) return;
    if (e.isPrimary) touches.clear(); // a new gesture: drop any finger whose lift we missed
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      touchMoved = false;
      touchStart = { x: e.clientX, y: e.clientY };
      if (!picking || onEmpty) startDrag(e);
    } else if (touches.size === 2) {
      drag = null;
      touchMoved = true;
      touchPinch = pinchOf();
      viewport.classList.add("panning");
    }
    return;
  }
  if (e.button === 1 || spaceDown || (e.button === 0 && onEmpty)) {
    e.preventDefault();
    startDrag(e);
    viewport.setPointerCapture(e.pointerId);
    if (onEmpty && !spaceDown) select(null);
  }
});
viewport.addEventListener("pointermove", (e) => {
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > TAP_SLOP) touchMoved = true;
    if (touchPinch && touches.size >= 2) {
      const p = pinchOf();
      cam.x += p.x - touchPinch.x;
      cam.y += p.y - touchPinch.y;
      zoomAt(p.x, p.y, cam.z * (p.d / touchPinch.d));
      touchPinch = p;
      return;
    }
  }
  if (!drag || e.pointerId !== drag.id) return;
  cam.x = drag.cx + (e.clientX - drag.x);
  cam.y = drag.cy + (e.clientY - drag.y);
  applyCamera();
});
const endDrag = (e: PointerEvent) => {
  if (touches.delete(e.pointerId)) {
    if (touches.size < 2) touchPinch = null;
    // lifting one finger of a pinch carries on as a pan with the other
    if (touches.size === 1) {
      const [[id, p]] = [...touches];
      drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y, id };
      return;
    }
    if (touches.size) return;
    if (touchMoved) swallowClicksUntil = performance.now() + 400;
    else if (e.type === "pointerup") tapAt(e);
  }
  drag = null;
  viewport.classList.remove("panning");
};
viewport.addEventListener("pointerup", endDrag);
viewport.addEventListener("pointercancel", endDrag);
viewport.addEventListener("click", (e) => {
  if (performance.now() < swallowClicksUntil) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);
/** A tap with Move: on a frame selects it, on empty canvas clears. */
function tapAt(e: PointerEvent) {
  if (picking) return;
  const frame = (e.target as Element).closest<HTMLElement>(".frame");
  if (frame) select(frame.dataset.id!);
  else if (e.target === viewport || e.target === world) select(null);
}

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
    if (document.body.classList.contains("view-open")) closeViewSheet();
    else if (focusedEdge) focusEdge(null);
    else if (targets.length) setTargets([], false);
    else if (picking || flowsAll) {
      // one press turns every tool off
      if (picking) setPicking(false);
      if (flowsAll) setFlowsAll(false);
    } else select(null);
    $("#connectPop").hidden = true;
  } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) fitAll();
  else if (e.key === ")" || (e.shiftKey && e.code === "Digit0")) zoomAt(innerWidth / 2, innerHeight / 2, 1);
  else if (e.key === "=" || e.key === "+") zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
  else if (e.key === "-") zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
  else if (e.key === "f" && selectedFrame) focusFrame(selectedFrame);
  else if (e.key === "h" || e.key === "H") setFullHeight(!fullHeight);
  else if (e.key === "d" || e.key === "D") setChrome(!showChrome);
  else if (e.key === "p" || e.key === "P") setFlowsAll(!flowsAll);
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
  focusedEdge = null;
  for (const [fid, el] of frameEls) el.classList.toggle("selected", fid === id);
  renderStepper();
  const path = id ? `/f/${fileId}/${id}` : `/f/${fileId}`;
  if (location.pathname !== path) history.replaceState(null, "", path + (id && hashFor(id) ? `#${hashFor(id)}` : ""));
  scheduleFlows();
}

function setPicking(on: boolean) {
  picking = on;
  if (!on) multi = false;
  $("#pickBtn").setAttribute("aria-pressed", String(on));
  $("#moveBtn").setAttribute("aria-pressed", String(!on));
  forEachDoc((doc) => {
    doc.documentElement.toggleAttribute("data-ds-picking", on);
    if (on) doc.getSelection()?.removeAllRanges();
    else doc.querySelectorAll("[data-ds-hover]").forEach((n) => n.removeAttribute("data-ds-hover"));
  });
  renderPickBar();
}
/**
 * Stays up while selecting: how many are selected and the keys that apply.
 * Touch has no Shift or Option, so it gets buttons for what those keys do.
 */
function renderPickBar() {
  const bar = $("#pickBar");
  bar.hidden = !picking;
  document.body.classList.toggle("picking", picking);
  if (!picking) return;
  const n = targets.length;
  if (coarse.matches) {
    const current = targets.at(-1);
    const actions = n
      ? [
        `<button class="btn" data-pick="parent" title="Select the element around it">↑ Parent</button>`,
        current && linkTarget(current) ? `<button class="btn" data-pick="go" title="Go where this link leads">Go →</button>` : "",
        `<button class="btn" data-pick="multi" aria-pressed="${multi}" title="Tap more elements to add or remove them">+ Add</button>`,
        `<button class="btn" data-pick="copy">Copy</button>`,
        `<button class="btn" data-pick="clear" aria-label="Clear selection">✕</button>`,
      ]
      : [];
    bar.innerHTML = `<b>${n ? `${n} selected` : "Tap an element to select it"}</b><div class="actions">${actions.join("")}</div>`;
    return;
  }
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
$("#moveBtn").addEventListener("click", () => setPicking(false));

/** Touch's Shift: while on, taps add or remove elements instead of replacing the selection. */
let multi = false;
/** A selected element in the frame's first screen. */
const elementOf = (t: Target) => primaryIframe(t.frameId)?.contentDocument?.querySelector(`[data-ds="${CSS.escape(t.elementId)}"]`) ?? null;
/** Where the selected element leads: the link it is or sits in, else the one link to a frame it holds. */
function linkTarget(t: Target) {
  const el = elementOf(t);
  if (!el) return null;
  const doc = el.ownerDocument;
  const inner = new Map<string, { kind: "edge"; to: string; toElement?: string }>();
  for (const l of linksOf(doc).links) {
    if (!l.el.contains(el) && !el.contains(l.el)) continue;
    const r = resolve(doc, t.frameId, l);
    if (r?.kind !== "edge") continue;
    if (l.el.contains(el)) return r;
    inner.set(`${r.to}/${r.toElement ?? ""}`, r);
  }
  return inner.size === 1 ? [...inner.values()][0] : null;
}
/** Option-click's job on touch: swap the current element for the one around it. */
function selectParent() {
  const t = targets.at(-1);
  const parent = t && elementOf(t)?.parentElement?.closest("[data-ds]");
  if (!t || !parent) return void toast("Nothing around it to select");
  const next = { frameId: t.frameId, elementId: parent.getAttribute("data-ds")! };
  setTargets([...targets.slice(0, -1).filter((x) => !(x.frameId === t.frameId && parent.contains(elementOf(x)))), next], false);
  if (targets.length === 1) copy(frameLink(next.frameId, next.elementId), `Copied link to ${describe(parent)}`);
  else copySelection();
}
$("#pickBar").addEventListener("click", (e) => {
  const action = (e.target as Element).closest<HTMLElement>("[data-pick]")?.dataset.pick;
  const t = targets.at(-1);
  if (action === "parent") selectParent();
  else if (action === "go" && t) {
    const r = linkTarget(t);
    if (r?.kind === "edge") {
      follow(r.to, r.toElement);
      if (!r.toElement) focusFrame(r.to);
    }
  } else if (action === "multi") {
    multi = !multi;
    renderPickBar();
  } else if (action === "copy") copySelection();
  else if (action === "clear") setTargets([], false);
});

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
html[data-ds-picking] * { cursor: crosshair !important; -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }
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
  // inner panes scroll too, so listen in the capture phase
  doc.addEventListener("scroll", scheduleFlows, { capture: true, passive: true });
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
    if (!picking) {
      if (e.altKey) followLinkAt(doc, frameId, e.target as Element);
      return;
    }
    const el = pickable(e.target, e.altKey);
    if (!el) return;
    const t = { frameId, elementId: el.getAttribute("data-ds")! };
    if (!e.shiftKey && !multi) {
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
  scheduleFlows();
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
  focusedEdge = null;
  renderPickBar();
  scheduleFlows();
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

// ---------- flows ----------
/**
 * Links between frames, drawn over the canvas in screen space so lines stay
 * crisp at any zoom. A selected element shows its links; P shows all.
 */
type Edge = {
  from: string;
  iframe: HTMLIFrameElement;
  el: Element;
  text: string;
  value: string;
  /** Missing when the link leads nowhere. */
  to?: string;
  toElement?: string;
};
type Box = { x: number; y: number; w: number; h: number; clip: DOMRect };

const flowEdges = $("#flowEdges") as unknown as SVGGElement;
const linkCache = new WeakMap<Document, ReturnType<typeof linksIn<Element>>>();
let drawnEdges: Edge[] = [];
let flowRaf = 0;
function scheduleFlows() {
  flowRaf ||= requestAnimationFrame(drawFlows);
}

const linksOf = (doc: Document) => {
  let found = linkCache.get(doc);
  if (!found) linkCache.set(doc, (found = linksIn<Element>(doc, fileId)));
  return found;
};
/** Flows start from and land on a frame's first screen (light, in "both" mode). */
const primaryIframe = (id: string) =>
  frameEls.get(id)?.querySelector<HTMLIFrameElement>(".screen iframe:not([data-loading])") ?? null;
const resolve = (doc: Document, from: string, l: ReturnType<typeof linksOf>["links"][number]) =>
  resolveLink(l.ref, from, (id) => frames.has(id), linksOf(doc).anchors);

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const from of frameOrder) {
    const iframe = primaryIframe(from);
    const doc = iframe?.contentDocument;
    if (!iframe || !doc?.body) continue;
    for (const l of linksOf(doc).links) {
      const r = resolve(doc, from, l);
      if (r) edges.push({ from, iframe, el: l.el, text: l.text, value: l.value, ...(r.kind === "edge" ? { to: r.to, toElement: r.toElement } : {}) });
    }
  }
  return edges;
}

/**
 * Selected elements always show their own links. Everything else needs P:
 * then the selected frame's links stand out, and the rest fade further the
 * narrower the selection is.
 */
type FlowState = "faint" | "dim" | "rest" | "on";
const FLOW_ORDER: FlowState[] = ["faint", "dim", "rest", "on"];
function edgeState(e: Edge): FlowState | null {
  if (focusedEdge) return edgeKey(e) === focusedEdge ? "on" : flowsAll ? "faint" : null;
  if (targets.length) {
    const on = targets.some((t) => {
      // the link itself, something inside it, or a container around it
      const sel = t.frameId === e.from ? e.el.ownerDocument.querySelector(`[data-ds="${CSS.escape(t.elementId)}"]`) : null;
      if (sel && (sel.contains(e.el) || e.el.contains(sel))) return true;
      return t.frameId === e.to && t.elementId === e.toElement;
    });
    return on ? "on" : flowsAll ? "faint" : null;
  }
  if (!flowsAll) return null;
  if (selectedFrame) return e.from === selectedFrame || e.to === selectedFrame ? "on" : "dim";
  return "rest";
}

/** An element's box on screen, and the visible part of its iframe. */
function boxOf(iframe: HTMLIFrameElement, el: Element): Box | null {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null; // display: none
  const clip = iframe.getBoundingClientRect();
  const k = clip.width / iframe.clientWidth;
  return { x: clip.left + r.left * k, y: clip.top + r.top * k, w: r.width * k, h: r.height * k, clip };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Where a line meets a box: its side facing the other end, its middle kept inside the visible frame. */
const sideOf = (b: Box, dir: 1 | -1) => ({
  x: dir > 0 ? Math.min(b.x + b.w, b.clip.right) : Math.max(b.x, b.clip.left),
  y: clamp(b.y + b.h / 2, b.clip.top + 6, b.clip.bottom - 6),
});
const n = (v: number) => v.toFixed(1);

function drawFlows() {
  flowRaf = 0;
  const bodies = new Map([...frameEls].map(([id, el]) => [id, el.querySelector(".frame-body")!.getBoundingClientRect()]));
  const labelTop = (id: string) => frameEls.get(id)!.querySelector(".frame-label")!.getBoundingClientRect().top;
  const shown = collectEdges()
    .map((e) => ({ e, state: edgeState(e) }))
    .filter((x): x is { e: Edge; state: FlowState } => !!x.state)
    .sort((a, b) => FLOW_ORDER.indexOf(a.state) - FLOW_ORDER.indexOf(b.state));
  const boxed = new Set<Element>();
  const selected = new Set(targets.map((t) => `${t.frameId}/${t.elementId}`));
  const parts: string[] = [];
  drawnEdges = [];

  for (const { e, state } of shown) {
    const src = boxOf(e.iframe, e.el);
    if (!src) continue;
    const i = drawnEdges.push(e) - 1;
    const offscreen = src.y + src.h < src.clip.top || src.y > src.clip.bottom;
    const fromName = frames.get(e.from)?.name ?? e.from;
    const what = e.text ? `“${e.text}”` : "Link";

    // dashed box around the link when the selection doesn't already outline it
    let box = "";
    if (state === "on" && !offscreen && !boxed.has(e.el) && !selected.has(`${e.from}/${e.el.getAttribute("data-ds")}`)) {
      boxed.add(e.el);
      const top = Math.max(src.y, src.clip.top);
      const bottom = Math.min(src.y + src.h, src.clip.bottom);
      box = `<rect class="box" x="${n(src.x - 2)}" y="${n(top - 2)}" width="${n(src.w + 4)}" height="${n(bottom - top + 4)}" rx="4"/>`;
    }

    if (!e.to) {
      const s = sideOf(src, 1);
      const d = `M${n(s.x)} ${n(s.y)}h30`;
      const ex = s.x + 37;
      const title = `${what} in ${fromName} links to ${e.value}, which isn't a frame in this file. Click to select it, then C copies its link for the agent.`;
      parts.push(`<g class="flow ${state} dead" data-edge="${i}"><title>${escapeHtml(title)}</title>${box}<path class="hit" d="${d}"/><path class="line" d="${d}"/>` +
        `<circle class="src" cx="${n(s.x)}" cy="${n(s.y)}" r="3.5"/><circle class="end" cx="${n(ex)}" cy="${n(s.y)}" r="7"/>` +
        `<path class="x" d="M${n(ex - 3)} ${n(s.y - 3)}l6 6m0 -6l-6 6"/></g>`);
      continue;
    }

    const body = bodies.get(e.to);
    if (!body) continue;
    const tIframe = primaryIframe(e.to);
    const tEl = e.toElement ? tIframe?.contentDocument?.querySelector(`[data-ds="${CSS.escape(e.toElement)}"]`) : null;
    const tgt = tIframe && tEl ? boxOf(tIframe, tEl) : null;
    const dir: 1 | -1 = (tgt ? tgt.x + tgt.w / 2 : body.left + body.width / 2) >= src.x + src.w / 2 ? 1 : -1;
    const s = sideOf(src, dir);
    const t = tgt
      ? sideOf(tgt, dir > 0 ? -1 : 1)
      : { x: dir > 0 ? body.left : body.right, y: body.top + Math.min(body.height / 2, 48 * cam.z) };
    // arc over any frames sitting between the two ends instead of cutting across them
    const lo = Math.min(s.x, t.x);
    const hi = Math.max(s.x, t.x);
    const tops = [...bodies].filter(([id, b]) => id !== e.from && id !== e.to && b.left > lo && b.right < hi).map(([id]) => labelTop(id));
    // longer handles when the ends are far apart vertically, so the line arrives level with its arrow
    const h = Math.max(40, (hi - lo) * 0.35, Math.min(Math.abs(t.y - s.y) * 0.5, 160));
    let c1 = s.y;
    let c2 = t.y;
    if (tops.length) c1 = c2 = Math.min(s.y, t.y, (Math.min(...tops) - 40 - (s.y + t.y) / 8) / 0.75);
    const d = `M${n(s.x)} ${n(s.y)}C${n(s.x + dir * h)} ${n(c1)} ${n(t.x - dir * h)} ${n(c2)} ${n(t.x)} ${n(t.y)}`;
    const title = `${what} in ${fromName} → ${frames.get(e.to)?.name ?? e.to}${tgt ? " (one element)" : ""}${offscreen ? " · scrolled out of view" : ""}. ${edgeKey(e) === focusedEdge ? "Click again to go there" : "Click to focus this link"}.`;
    parts.push(`<g class="flow ${state}" data-edge="${i}"><title>${escapeHtml(title)}</title>${box}<path class="hit" d="${d}"/>` +
      `<path class="line" d="${d}" marker-end="url(#flowArrow)"/><circle class="src${offscreen ? " off" : ""}" cx="${n(s.x)}" cy="${n(s.y)}" r="3.5"/></g>`);
  }
  flowEdges.innerHTML = parts.join("");
}

/** Go where a link leads: its frame, or the exact element when it names one. */
function follow(to: string, element?: string) {
  if (element) return setTargets([{ frameId: to, elementId: element }], true);
  if (targets.length) setTargets([], false);
  selectAndReveal(to);
}
function followLinkAt(doc: Document, frameId: string, target: Element) {
  const l = linksOf(doc).links.find((x) => x.el.contains(target));
  if (!l) return;
  const r = resolve(doc, frameId, l);
  if (r?.kind === "edge") follow(r.to, r.toElement);
  else if (r) toast(`That link (${escapeHtml(l.value)}) doesn't lead to a frame`);
}

/** A clicked line: shown on its own, everything else faded or hidden, until Esc or another selection. */
let focusedEdge: string | null = null;
const edgeKey = (e: Edge) => `${e.from}/${e.el.getAttribute("data-ds")}>${e.to ?? ""}/${e.toElement ?? ""}`;
function focusEdge(key: string | null) {
  focusedEdge = key;
  scheduleFlows();
}

$("#flows").addEventListener("click", (ev) => {
  const g = (ev.target as Element).closest<SVGGElement>("[data-edge]");
  const e = g && drawnEdges[Number(g.dataset.edge)];
  if (!e) return;
  if (!e.to) return setTargets([{ frameId: e.from, elementId: e.el.getAttribute("data-ds")! }], true);
  // first click focuses the line, a second one goes where it leads
  if (edgeKey(e) === focusedEdge) follow(e.to, e.toElement);
  else focusEdge(edgeKey(e));
});

function setFlowsAll(on: boolean) {
  flowsAll = on;
  prefs.set("flowsAll", on);
  $("#flowsBtn").setAttribute("aria-pressed", String(on));
  scheduleFlows();
  if (on && frames.size > 1 && !collectEdges().some((e) => e.to)) {
    toast("No links between frames yet. Ask the agent to link screens with <code>href=\"#&lt;frame id&gt;\"</code>", 4000);
  }
}
$("#flowsBtn").setAttribute("aria-pressed", String(flowsAll));
$("#flowsBtn").addEventListener("click", () => setFlowsAll(!flowsAll));
addEventListener("resize", scheduleFlows);

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
    <div class="frame-body"></div>
    <i class="resize e" data-axis="e" title="Drag to resize every frame"></i>
    <i class="resize s" data-axis="s" title="Drag to resize every frame"></i>
    <i class="resize se" data-axis="se" title="Drag to resize every frame"></i>`;
  el.querySelectorAll<HTMLElement>(".resize").forEach((h) => wireResize(h, f.id));
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
    <div class="chrome" aria-hidden="true">
      <div class="status"><span class="time">9:41</span><span class="icons">${STATUS_ICONS}</span></div>
      <i class="cutout"></i><i class="home-bar"></i>
    </div>
    <div class="scheme">${scheme}</div>`;
  return s;
}

const STATUS_ICONS = `<svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>` +
  `<svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 2.6a10 10 0 0 1 6.6 2.5l1.2-1.3A11.8 11.8 0 0 0 8 .8 11.8 11.8 0 0 0 .2 3.8l1.2 1.3A10 10 0 0 1 8 2.6zm0 3.6a6.3 6.3 0 0 1 4.2 1.6l1.2-1.3A8 8 0 0 0 8 4.4a8 8 0 0 0-5.4 2.1l1.2 1.3A6.3 6.3 0 0 1 8 6.2zm0 3.5a2.6 2.6 0 0 1 1.7.7L8 12.2l-1.7-1.8a2.6 2.6 0 0 1 1.7-.7z"/></svg>` +
  `<svg viewBox="0 0 28 13" width="27" height="13"><rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2.5" y="2.5" width="18" height="8" rx="2.2"/><path d="M26 4.5v4a2.2 2.2 0 0 0 0-4z" opacity=".45"/></svg>`;

/** Device size, corner radius and safe areas on a screen; chrome is drawn only when D is on. */
function dressScreen(screen: HTMLElement, d: Device) {
  screen.classList.toggle("device", showChrome && d.radius > 0);
  screen.dataset.kind = d.kind;
  screen.dataset.cutout = d.cutout ?? "";
  screen.style.setProperty("--radius", `${d.radius}px`);
  screen.style.setProperty("--safe-top", `${d.safeTop}px`);
  screen.style.setProperty("--safe-bottom", `${d.safeBottom}px`);
}

/** Frames pad around the device's status bar and home indicator with var(--ds-safe-top/bottom). */
function applySafeArea(iframe: HTMLIFrameElement, d: Device) {
  const doc = iframe.contentDocument;
  if (!doc?.head) return;
  let style = doc.head.querySelector<HTMLStyleElement>("style[data-ds-device]");
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute("data-ds-device", "");
    doc.head.append(style);
  }
  style.textContent = `:root { --ds-safe-top: ${d.safeTop}px; --ds-safe-bottom: ${d.safeBottom}px; }`;
}

/** Load a new render behind the current one and swap on load, so updates don't flash. */
function loadInto(screen: HTMLElement, f: FrameSummary, scheme: Scheme, d: Device) {
  const src = frameSrc(f, scheme);
  const current = screen.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
  if (current?.dataset.src === src) return;
  screen.querySelectorAll("iframe[data-loading]").forEach((n) => n.remove());

  const next = document.createElement("iframe");
  // allow-scripts only so Safari runs the listeners instrument() attaches; the
  // render's CSP (script-src 'none') still blocks every script the frame carries.
  // Still no forms, popups or top navigation.
  next.setAttribute("sandbox", "allow-same-origin allow-scripts");
  next.setAttribute("loading", "eager");
  next.title = `${f.name} (${scheme})`;
  next.dataset.src = src;
  next.dataset.loading = "";
  next.style.cssText = `position:absolute;inset:0 auto auto 0;width:${d.w}px;height:${d.h}px;opacity:0;color-scheme:${scheme}`;
  next.addEventListener("load", () => {
    // the device may have changed while this loaded
    const dev = currentDevice();
    applySafeArea(next, dev);
    const h = frameHeight(next, dev);
    next.style.cssText = `width:${dev.w}px;height:${h}px;color-scheme:${scheme}`;
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
function frameHeight(iframe: HTMLIFrameElement, d: Device) {
  const vh = d.h;
  if (!fullHeight) return vh;
  iframe.style.height = `${vh}px`; // measure at device height so 100vh layouts don't feed back
  return Math.min(12000, Math.max(vh, iframe.contentDocument?.documentElement.scrollHeight ?? vh));
}

/** Resize loaded frames in place (width or height mode changed) without reloading them. */
function resizeScreens() {
  for (const [id, el] of frameEls) {
    const f = frames.get(id);
    if (!f) continue;
    const d = currentDevice();
    for (const screen of el.querySelectorAll<HTMLElement>(".screen")) {
      screen.style.width = `${d.w}px`;
      dressScreen(screen, d);
      const iframe = screen.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
      if (!iframe) {
        screen.style.height = `${d.h}px`;
        continue;
      }
      iframe.style.width = `${d.w}px`;
      applySafeArea(iframe, d);
      const h = frameHeight(iframe, d);
      iframe.style.height = screen.style.height = `${h}px`;
    }
    syncPairHeights(id);
  }
  scheduleFlows();
}

// ---------- resize (Safari's responsive design mode) ----------
function wireResize(handle: HTMLElement, frameId: string) {
  let drag: { x: number; y: number; w: number; h: number; screens: number; base: string } | null = null;
  let raf = 0;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a canvas pan
    const d = currentDevice();
    const screens = frameEls.get(frameId)!.querySelectorAll(".screen").length || 1;
    drag = { x: e.clientX, y: e.clientY, w: d.w, h: d.h, screens, base: d.id === "custom" ? custom!.base : d.id };
    handle.setPointerCapture(e.pointerId);
    viewport.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const axis = handle.dataset.axis!;
    // in "both" mode the edge moves once per screen
    const dw = axis.includes("e") ? (e.clientX - drag.x) / cam.z / drag.screens : 0;
    const dh = axis.includes("s") ? (e.clientY - drag.y) / cam.z : 0;
    custom = {
      w: Math.round(clamp(drag.w + dw, 240, 3840)),
      h: Math.round(clamp(drag.h + dh, 320, 2400)),
      base: drag.base,
    };
    deviceId = "custom";
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      renderAll();
      resizeScreens();
    });
    toast(`${custom.w} × ${custom.h}`, 900);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    viewport.classList.remove("resizing");
    prefs.set("custom", custom);
    saveDevice();
    renderDevicePicker();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function setChrome(on: boolean) {
  showChrome = on;
  prefs.set("chrome", on);
  $("#chromeBtn").setAttribute("aria-pressed", String(on));
  renderAll();
}

function setFullHeight(on: boolean) {
  fullHeight = on;
  prefs.set("fullHeight", on);
  viewport.classList.toggle("full-height", on);
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
  const d = currentDevice();
  const working = f.status === "working" && (!f.lockExpiresAt || f.lockExpiresAt > Date.now());
  el.classList.toggle("working", working);
  el.classList.toggle("has-content", f.hasContent);
  el.classList.toggle("selected", selectedFrame === f.id);
  el.querySelector(".name")!.textContent = f.name;
  el.querySelector(".meta")!.textContent = `${f.version ? `v${f.version}` : "new"} · ${d.id === "custom" ? d.name : `${d.name} · ${d.w}`}`;
  el.classList.toggle("dressed", showChrome && d.radius > 0);

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
    screen.style.width = `${d.w}px`;
    if (!screen.style.height) screen.style.height = `${d.h}px`;
    dressScreen(screen, d);
    screen.querySelector(".task-text")!.textContent = f.task ? `Working · ${f.task}` : "Working…";
    screen.querySelector<HTMLElement>(".scheme")!.style.display = themeMode === "both" ? "" : "none";
    if (f.hasContent) loadInto(screen, f, scheme, d);
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
  renderStepper();
  maybeInitialFocus();
  scheduleFlows();
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
const deviceSel = $("#deviceSel") as HTMLSelectElement;
function renderDevicePicker() {
  const customOpt = custom ? `<option value="custom">Custom · ${custom.w}×${custom.h}</option>` : "";
  deviceSel.innerHTML = customOpt + [...new Set(DEVICES.map((d) => d.group))]
    .map((g) => `<optgroup label="${g}">${DEVICES.filter((d) => d.group === g).map((d) => `<option value="${d.id}">${escapeHtml(d.name)} · ${d.w}</option>`).join("")}</optgroup>`)
    .join("");
  deviceSel.value = deviceId;
}
renderDevicePicker();
viewport.classList.toggle("full-height", fullHeight);
deviceSel.addEventListener("change", () => {
  deviceId = deviceSel.value;
  saveDevice();
  renderAll();
  resizeScreens();
});
$("#chromeBtn").setAttribute("aria-pressed", String(showChrome));
$("#chromeBtn").addEventListener("click", () => setChrome(!showChrome));
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

// frame stepper: one frame at a time, fitted to the screen
function renderStepper() {
  const i = selectedFrame ? frameOrder.indexOf(selectedFrame) : -1;
  $("#frameCount").textContent = frameOrder.length ? `${i < 0 ? "–" : i + 1}/${frameOrder.length}` : "–";
  for (const id of ["#prevFrame", "#nextFrame", "#frameCount"]) ($(id) as HTMLButtonElement).disabled = !frameOrder.length;
}
function step(by: 1 | -1) {
  if (!frameOrder.length) return;
  const n = frameOrder.length;
  const i = selectedFrame ? frameOrder.indexOf(selectedFrame) : -1;
  const id = frameOrder[i < 0 ? (by > 0 ? 0 : n - 1) : (i + by + n) % n];
  if (targets.length) setTargets([], false);
  select(id);
  focusFrame(id);
}
$("#prevFrame").addEventListener("click", () => step(-1));
$("#nextFrame").addEventListener("click", () => step(1));
$("#frameCount").addEventListener("click", fitAll);

// view sheet (phones): the bar's view settings, opened from the dock
function closeViewSheet() {
  document.body.classList.remove("view-open");
  $("#viewBtn").setAttribute("aria-expanded", "false");
}
$("#viewBtn").addEventListener("click", () => {
  const open = document.body.classList.toggle("view-open");
  $("#viewBtn").setAttribute("aria-expanded", String(open));
  if (open) pop.hidden = true;
});

// share: the selected elements, else the selected frame, else the file
$("#shareBtn").addEventListener("click", async () => {
  const url = targets.length
    ? [...new Set(targets.map((t) => t.frameId))].map((fid) => frameLink(fid, hashFor(fid))).join("\n")
    : selectedFrame ? frameLink(selectedFrame) : `${location.origin}/f/${fileId}`;
  const what = targets.length ? "the selected elements" : selectedFrame ? "this frame" : "this file";
  if (navigator.share && !url.includes("\n")) {
    try {
      return void (await navigator.share({ url, title: document.title }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
    }
  }
  copy(url, `Copied link to ${what}`);
});

// connect popover
const pop = $("#connectPop");
const togglePop = () => {
  pop.hidden = !pop.hidden;
  closeViewSheet();
};
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
  if (!deviceChosen) {
    deviceFromPins(file.frames);
    deviceChosen = true; // decide once per visit, not on every reconnect
  }
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
