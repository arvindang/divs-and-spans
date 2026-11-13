import { $, copy, escapeHtml, forgetFile, prefs, rememberFile, toast, viewerId, wireCopyButtons } from "./shared";
import { linksIn, resolveLink } from "../src/flows";
import { CHROME_CSS, CHROME_HTML } from "../src/chrome";
import { initComments } from "./comments";
import { DEFAULT_BY_KIND, DEVICES, EMBED_SIZES, customDevice, deviceById, deviceForLegacyWidth, embedSizeOf, kindForWidth, type CustomSize, type Device, type DeviceKind } from "./devices";

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
/** ⌘ on Apple devices, Ctrl elsewhere: the copy shortcuts follow the platform's own. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl+";
const frameLink = (frameId: string, el?: string) => `${location.origin}/f/${fileId}/${frameId}${el ? `#${el}` : ""}`;
/** The frame on its own page; with Both on, the page follows the viewer's system scheme. */
const viewLink = (frameId: string) => `${location.origin}/f/${fileId}/${frameId}/view${themeMode === "both" ? "" : `?theme=${themeMode}`}`;

// ---------- camera ----------
function applyCamera() {
  // one NaN (e.g. from a bad gesture value) would otherwise stick forever, Fit included
  if ([cam.x, cam.y, cam.z].every(Number.isFinite)) lastGoodCam = { ...cam };
  else cam = { ...lastGoodCam };
  if (cam.z !== rasterZ) settleRaster();
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  viewport.style.setProperty("--z", String(cam.z));
  viewport.style.setProperty("--bx", `${cam.x}px`);
  viewport.style.setProperty("--by", `${cam.y}px`);
  $("#zoomLabel .z").textContent = `${Math.round(cam.z * 100)}%`;
  viewport.classList.toggle("tiny", cam.z < 0.3);
  scheduleFlows();
}
/**
 * Browsers stretch a cached bitmap of the world while its scale changes and
 * don't always repaint it once the zoom stops (Safari leaves it blurry).
 * Hold the layer on will-change during a zoom and drop it after a pause,
 * which makes the browser repaint at the new scale.
 */
let rasterZ = cam.z;
let rasterTimer = 0;
function settleRaster() {
  world.style.willChange = "transform";
  clearTimeout(rasterTimer);
  rasterTimer = window.setTimeout(() => {
    rasterZ = cam.z;
    world.style.willChange = "";
  }, 200);
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
  // the frame label rail runs down the left edge, bezel included
  const padLeft = Math.max(padX, 60);
  // clear the bar plus the copy link on top, and the dock on phones
  const padTop = phone.matches ? $(".bar").getBoundingClientRect().bottom + 56 : 110;
  const padBottom = phone.matches ? innerHeight - $("#tools").getBoundingClientRect().top + 16 : 60;
  // the comments panel covers the right edge on desktop
  const padRight = !phone.matches && document.body.classList.contains("commenting") ? 324 : padX;
  const vw = viewport.clientWidth - padLeft - padRight;
  const vh = viewport.clientHeight - padTop - padBottom;
  const z = Math.min(maxZ, vw / r.w, vh / r.h);
  cam = {
    z,
    x: padLeft + (vw - r.w * z) / 2 - r.x * z,
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
function onWheel(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; clientX: number; clientY: number }, zoom: boolean) {
  const scale = e.deltaMode === 1 ? 16 : 1;
  if (zoom) {
    if (pinch) pinch.viaWheel = true;
    // a mouse wheel notch is ~100 where a pinch step is a few; cap it so one notch can't jump 3x
    const dy = Math.min(50, Math.max(-50, e.deltaY * scale));
    zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-dy * 0.01));
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
  const to = routeWheel(e, () => null);
  // a frame pane's scroll whose momentum carries the pointer off the frame keeps scrolling that pane
  if (typeof to !== "string") scrollPane(to, e);
  else onWheel(e, to === "zoom");
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
let wheelLatch: { to: "canvas" | "zoom" | Element; t: number } | null = null;

/** Where one wheel event goes: the canvas (pan), a zoom, or the frame pane the gesture is latched to. */
function routeWheel(e: WheelEvent, paneUnder: () => Element | null) {
  const now = performance.now();
  const latch = wheelLatch && now - wheelLatch.t <= WHEEL_GESTURE_GAP_MS ? wheelLatch : null;
  // pinch arrives as ctrl+wheel, so ctrl always zooms; Cmd+wheel zooms only when the gesture began
  // with it, so pressing Cmd (say for Cmd+C) during a scroll's momentum doesn't zoom the rest of it
  let to: "canvas" | "zoom" | Element;
  if (e.ctrlKey || (e.metaKey && (!latch || latch.to === "zoom"))) to = "zoom";
  else if (!latch || latch.to === "zoom" || (typeof latch.to !== "string" && !latch.to.isConnected)) to = paneUnder() ?? "canvas";
  else to = latch.to;
  wheelLatch = { to, t: now };
  return to;
}
const scrollPane = (pane: Element, e: WheelEvent) => {
  const k = e.deltaMode === 1 ? 16 : 1;
  pane.scrollBy(e.deltaX * k, e.deltaY * k);
};

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
  closeExport();
  const onEmpty = e.target === viewport || e.target === world;
  if (e.pointerType === "touch") {
    // flow lines and resize handles keep their own touches
    if ((e.target as Element).closest(".hit, .resize, .pin")) return;
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
  if (!trashedCard.hidden) return;
  if (e.code === "Space") {
    spaceDown = down;
    viewport.classList.toggle("space", down);
    e.preventDefault();
    return;
  }
  if (!down) return;
  // ⌘C copies the selection's link, unless there's text highlighted to copy
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyC" && (targets.length || selectedFrame) && !hasTextSelection()) {
    copySelection();
    e.preventDefault();
    return;
  }
  // ⌘Z brings back the frames you deleted here, newest first
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyZ" && undoStack.length) {
    restoreFrame(undoStack.pop()!);
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const del = e.key === "Backspace" || e.key === "Delete";
  if (del && e.shiftKey) toggleTrash();
  else if (del && selectedFrame && !targets.length) deleteFrame(selectedFrame);
  else if (e.key === "l" || e.key === "L") setPicking(!picking);
  else if (e.code === "KeyC" && !e.shiftKey) comments.toggle();
  else if (e.key === "Escape") {
    if (document.body.classList.contains("view-open")) closeViewSheet();
    else if (comments.escape()) {}
    else if (focusedEdge) focusEdge(null);
    else if (targets.length) setTargets([], false);
    else if (picking || flowsAll) {
      // one press turns every tool off
      if (picking) setPicking(false);
      if (flowsAll) setFlowsAll(false);
    } else select(null);
    $("#connectPop").hidden = true;
    closeExport();
    closeTrash();
    closeEmbed();
  } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) fitAll();
  else if (e.key === ")" || (e.shiftKey && e.code === "Digit0")) zoomAt(innerWidth / 2, innerHeight / 2, 1);
  else if (e.key === "=" || e.key === "+") zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
  else if (e.key === "-") zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
  else if (e.key === "f" && selectedFrame) focusFrame(selectedFrame);
  else if (e.key === "h" || e.key === "H") setFullHeight(!fullHeight);
  else if (e.key === "d" || e.key === "D") setChrome(!showChrome);
  else if (e.key === "p" || e.key === "P") setFlowsAll(!flowsAll);
  else if (e.key === "t" || e.key === "T") setTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length]);
  else if (e.key === "[" || e.key === "]") stepDevice(e.key === "]" ? 1 : -1);
  else if (e.key === "e" || e.key === "E") $("#exportZip").click();
  else if ((e.key === "o" || e.key === "O") && selectedFrame) window.open(viewLink(selectedFrame), "_blank", "noopener");
  else if ((e.key === "i" || e.key === "I") && (e.shiftKey || selectedFrame)) openEmbed(e.shiftKey ? "" : selectedFrame!);
  else if (/^[0-9]$/.test(e.key) && frameOrder[+e.key]) selectAndReveal(frameOrder[+e.key]);
  else if (e.key === "Tab" && frameOrder.length) {
    const i = selectedFrame ? frameOrder.indexOf(selectedFrame) : -1;
    const n = frameOrder.length;
    selectAndReveal(frameOrder[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n]);
  }  else return;
  e.preventDefault();
}
/** Text highlighted on the page or in a frame: ⌘C should copy that, as usual. */
function hasTextSelection() {
  if (getSelection()?.isCollapsed === false) return true;
  let found = false;
  forEachDoc((doc) => {
    if (doc.getSelection()?.isCollapsed === false) found = true;
  });
  return found;
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
  if (on) comments.toggle(false);
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
    n ? `<kbd>${MOD}C</kbd> copy link` : "",
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
$("#moveBtn").addEventListener("click", () => {
  setPicking(false);
  comments.toggle(false);
});

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
html[data-ds-picking] *, html[data-ds-commenting] * { cursor: crosshair !important; -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }
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
  doc.documentElement.toggleAttribute("data-ds-commenting", comments.on());

  const toParent = (e: MouseEvent | WheelEvent) => {
    const r = iframe.getBoundingClientRect();
    const k = r.width / iframe.clientWidth;
    return { clientX: r.left + e.clientX * k, clientY: r.top + e.clientY * k };
  };
  doc.addEventListener("wheel", (e) => {
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const to = routeWheel(e, () => scrollerFor(e.target as Element, win, horizontal));
    if (typeof to !== "string") {
      // the pane under the pointer scrolls natively; nothing reaches the canvas
      if (to.contains(e.target as Node)) return;
      // pointer drifted off the pane mid-gesture: keep scrolling it
      e.preventDefault();
      scrollPane(to, e);
      return;
    }
    e.preventDefault();
    const p = toParent(e);
    onWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey, ...p }, to === "zoom");
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
  watchActivity(doc);

  const pickable = (t: EventTarget | null, parent: boolean) => {
    let el = (t as Element | null)?.closest?.("[data-ds]") ?? null;
    if (el && parent) el = el.parentElement?.closest("[data-ds]") ?? el;
    return el;
  };
  let hovered: Element | null = null;
  doc.addEventListener("mouseover", (e) => {
    if (!picking && !comments.on()) return;
    hovered?.removeAttribute("data-ds-hover");
    hovered = pickable(e.target, e.altKey);
    hovered?.setAttribute("data-ds-hover", "");
  });
  doc.addEventListener("mouseleave", () => hovered?.removeAttribute("data-ds-hover"));
  // no text selection (drag or Shift-click) while selecting elements
  doc.addEventListener("mousedown", (e) => (picking || comments.on()) && e.preventDefault(), true);
  doc.addEventListener("click", (e) => {
    e.preventDefault(); // designs are static: links and buttons never navigate
    if (comments.on()) return void comments.placeInFrame(frameId, iframe, e, pickable(e.target, e.altKey));
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
  comments.schedule();
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
    </div>
    <div class="frame-actions">
      <a data-act="open" target="_blank" rel="noopener" title="Open this frame on its own page to share as is (O when selected)">Open ↗ <kbd>O</kbd></a>
      <button data-act="embed" title="Embed this frame in Notion, Confluence or any page: read-only, live, click-through (I when selected)">Embed <kbd>I</kbd></button>
      <button data-act="link" title="Copy frame link (${MOD}C when selected)">Copy link <kbd>${MOD}C</kbd></button>
    </div>
    <div class="frame-body"></div>
    <i class="resize e" data-axis="e" title="Drag to resize every frame"></i>
    <i class="resize s" data-axis="s" title="Drag to resize every frame"></i>
    <i class="resize se" data-axis="se" title="Drag to resize every frame"></i>`;
  el.querySelectorAll<HTMLElement>(".resize").forEach((h) => wireResize(h, f.id));
  const open = el.querySelector<HTMLAnchorElement>("[data-act=open]")!;
  const syncOpen = () => (open.href = viewLink(f.id));
  syncOpen();
  ["pointerenter", "focus", "contextmenu"].forEach((t) => open.addEventListener(t, syncOpen));
  el.querySelector(".frame-actions")!.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    e.stopPropagation();
    if (act === "link") copy(frameLink(f.id), "Copied frame link");
    if (act === "embed") openEmbed(f.id);
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
    ${CHROME_HTML}
    <div class="scheme">${scheme}</div>`;
  return s;
}

// from src/chrome.ts; before app.css so the canvas's own shadows win
const chromeStyle = document.createElement("style");
chromeStyle.textContent = CHROME_CSS;
document.head.prepend(chromeStyle);

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
    watchHeight(next, f.id);
    syncPairHeights(f.id);
    maybeInitialFocus();
  }, { once: true });
  next.src = src;
  screen.prepend(next);
}

/** Screen mode shows one device viewport and the document scrolls inside; full height grows to the content. */
function frameHeight(iframe: HTMLIFrameElement, d: Device) {
  const vh = d.h;
  const doc = iframe.contentDocument;
  if (!fullHeight || !doc) return vh;
  iframe.style.height = `${vh}px`; // measure at device height so 100vh layouts don't feed back
  let h = doc.documentElement.scrollHeight;
  // app shells scroll a viewport-tall pane, not the document: grow by that pane's
  // overflow, keeping only what the pane actually gains (a max-height list won't)
  const pane = tallestPane(doc, vh);
  if (pane) {
    const extra = pane.scrollHeight - pane.clientHeight;
    iframe.style.height = `${vh + extra}px`;
    h = Math.max(h, vh + extra - Math.max(0, pane.scrollHeight - pane.clientHeight));
  }
  return Math.min(12000, Math.max(vh, h));
}

/** The scrolling pane with the most hidden content among those at least half the viewport tall. */
function tallestPane(doc: Document, vh: number): Element | null {
  const win = doc.defaultView;
  if (!win || !doc.body) return null;
  let best: Element | null = null;
  let most = 1;
  for (const el of doc.body.querySelectorAll("*")) {
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= most || el.clientHeight < vh / 2) continue;
    if (!/(auto|scroll|overlay)/.test(win.getComputedStyle(el).overflowY)) continue;
    best = el;
    most = overflow;
  }
  return best;
}

/** Size one frame's loaded screens to the current device and height mode. */
function fitFrame(id: string) {
  const el = frameEls.get(id);
  if (!el || !frames.has(id)) return;
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

/** Resize loaded frames in place (width or height mode changed) without reloading them. */
function resizeScreens() {
  for (const id of frameEls.keys()) fitFrame(id);
  scheduleFlows();
}

/**
 * Content can change height after load: web fonts swap in, lazy images load once full
 * height reveals them. Refit the frame when it does. Measuring resets the iframe to
 * device height and back within one task, so a stable size doesn't notify again.
 */
function watchHeight(iframe: HTMLIFrameElement, frameId: string) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow as (Window & typeof globalThis) | null;
  if (!doc || !win) return;
  let raf = 0;
  const refit = () => {
    if (!fullHeight || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!iframe.isConnected || iframe.dataset.loading !== undefined) return;
      fitFrame(frameId);
      scheduleFlows();
    });
  };
  // the iframe's own ResizeObserver, so observations run with its document's rendering
  const ro = new win.ResizeObserver(refit);
  ro.observe(doc.documentElement);
  if (doc.body) ro.observe(doc.body);
  doc.fonts?.ready.then(refit);
  doc.addEventListener("load", refit, true); // images, including lazy ones
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
  if (comments.initialFocus()) return;
  const hash = location.hash.slice(1);
  if (initialFrameId && frames.has(initialFrameId)) {
    if (hash) setTargets(hash.split(",").map((elementId) => ({ frameId: initialFrameId, elementId })), true);
    else focusFrame(initialFrameId);
  } else fitAll();
}

// ---------- controls ----------
const THEMES: ThemeMode[] = ["light", "dark", "both"];
function setTheme(mode: ThemeMode) {
  themeMode = mode;
  prefs.set("theme", themeMode);
  renderAll();
}
for (const btn of document.querySelectorAll<HTMLElement>("[data-theme-mode]")) {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeMode as ThemeMode));
}
/** [ and ]: the previous or next device in the picker's order. */
function stepDevice(by: 1 | -1) {
  const ids = [...(custom ? ["custom"] : []), ...DEVICES.map((d) => d.id)];
  deviceId = ids[(ids.indexOf(deviceId) + by + ids.length) % ids.length];
  deviceSel.value = deviceId;
  saveDevice();
  renderAll();
  resizeScreens();
  const d = currentDevice();
  toast(`${escapeHtml(d.name)} · ${d.w} × ${d.h}`, 1200);
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
const exportPop = $("#exportPop");
function closeExport() {
  exportPop.hidden = true;
  $("#exportBtn").setAttribute("aria-expanded", "false");
}
const togglePop = () => {
  pop.hidden = !pop.hidden;
  closeExport();
  closeTrash();
  closeEmbed();
  closeViewSheet();
};
$("#connectBtn").addEventListener("click", togglePop);
$("#emptyConnect").addEventListener("click", togglePop);
($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
($("#fileUrl") as HTMLInputElement).value = `${location.origin}/f/${fileId}`;
($("#tokensLink") as HTMLAnchorElement).href = `/api/files/${fileId}/tokens.css`;
($("#exportZip") as HTMLAnchorElement).href = `/api/files/${fileId}/export.zip`;
$("#exportZip").addEventListener("click", () => {
  closeExport();
  toast("Downloading every frame as a zip");
});
$("#exportBtn").addEventListener("click", () => {
  exportPop.hidden = !exportPop.hidden;
  $("#exportEmbed").toggleAttribute("aria-disabled", ![...frames.values()].some((f) => f.hasContent));
  $("#exportBtn").setAttribute("aria-expanded", String(!exportPop.hidden));
  pop.hidden = true;
  closeTrash();
  closeEmbed();
  closeViewSheet();
});
$("#promptEx").textContent = `${location.origin}/f/${fileId}\nDesign the home screen for …`;
wireCopyButtons();

// ---------- trash ----------
// No auth, so anyone with the link can delete; the trash makes that recoverable for anyone with the link too.
interface Trashed {
  id: string;
  name: string;
  deletedAt: number;
  purgeAt: number;
}
const trashPop = $("#trashPop");
const trashedCard = $("#trashed");
const deleteFileBtn = $("#deleteFileBtn");
/** Frames deleted from this canvas this visit, newest last. */
const undoStack: string[] = [];

async function fileApi<T = any>(path: string, method = "GET"): Promise<T> {
  const res = await fetch(`/api/files/${fileId}${path}`, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}
const failed = (err: unknown) => toast(escapeHtml((err as Error).message), 4000);
function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

async function deleteFrame(id: string) {
  const f = frames.get(id);
  if (!f) return;
  try {
    await fileApi(`/frames/${id}`, "DELETE");
  } catch (err) {
    return failed(err);
  }
  undoStack.push(id);
  if (targets.some((t) => t.frameId === id)) setTargets([], false);
  if (selectedFrame === id) select(null);
  frames.delete(id);
  renderAll();
  if (!trashPop.hidden) renderTrash();
  toast(`Deleted “${escapeHtml(f.name)}” · <kbd>${MOD}Z</kbd> to undo`, 5000);
}

async function restoreFrame(id: string) {
  const i = undoStack.lastIndexOf(id);
  if (i >= 0) undoStack.splice(i, 1);
  try {
    const f = await fileApi<FrameSummary>(`/frames/${id}/restore`, "POST");
    frames.set(f.id, f);
    renderAll();
    selectAndReveal(f.id);
    toast(`Restored “${escapeHtml(f.name)}”`);
  } catch (err) {
    failed(err);
  }
  if (!trashPop.hidden) renderTrash();
}

async function renderTrash() {
  const sel = selectedFrame && frames.get(selectedFrame);
  deleteFrameBtn.hidden = !sel;
  if (sel) deleteFrameBtn.firstChild!.textContent = `Delete “${sel.name}” `;
  let items: Trashed[] = [];
  try {
    items = (await fileApi<{ frames: Trashed[] }>("/trash")).frames;
  } catch {}
  $("#trashList").innerHTML = items.length
    ? items
        .map((t) => `<li><span class="name">${escapeHtml(t.name)}</span><time>${ago(t.deletedAt)}</time><button class="btn" data-restore="${t.id}">Restore</button></li>`)
        .join("")
    : `<li class="none">No deleted frames.</li>`;
}
const deleteFrameBtn = $("#deleteFrameBtn");
deleteFrameBtn.querySelector("span")!.textContent = `The selected frame. ${MOD}Z or Restore below brings it back.`;
deleteFrameBtn.addEventListener("click", () => selectedFrame && deleteFrame(selectedFrame));
$("#trashList").addEventListener("click", (e) => {
  const id = (e.target as Element).closest<HTMLElement>("[data-restore]")?.dataset.restore;
  if (id) restoreFrame(id);
});

function closeTrash() {
  trashPop.hidden = true;
  $("#trashBtn").setAttribute("aria-expanded", "false");
  disarmDelete();
}
function toggleTrash() {
  const open = trashPop.hidden;
  closeExport();
  closeEmbed();
  pop.hidden = true;
  closeViewSheet();
  if (!open) return closeTrash();
  trashPop.hidden = false;
  $("#trashBtn").setAttribute("aria-expanded", "true");
  renderTrash();
}
$("#trashBtn").addEventListener("click", toggleTrash);

// ---------- embed ----------
// A read-only, live player of one frame and the frames it links to, for Notion, Confluence
// and the like. Its link carries its own key, never the file id (which would allow editing).
const embedPop = $("#embedPop");
const embedDevice = $("#embedDevice") as HTMLSelectElement;
const embedTheme = $("#embedTheme") as HTMLSelectElement;
const embedRevoke = $("#embedRevoke");
/** The frame the open embed popover is for, "" for the whole file, null when it's closed. */
let embedFor: string | null = null;
let embedBase = "";
function embedLink() {
  const p = new URLSearchParams({ device: embedDevice.value });
  if (embedTheme.value) p.set("theme", embedTheme.value);
  return `${embedBase}?${p}`;
}
function syncEmbed() {
  ($("#embedUrl") as HTMLInputElement).value = embedLink();
  ($("#embedPreview") as HTMLAnchorElement).href = embedLink();
}
const embedApi = (frameId: string) => `/api/files/${fileId}/embeds${frameId ? `/${frameId}` : ""}`;
function closeEmbed() {
  embedPop.hidden = true;
  embedFor = null;
  delete embedRevoke.dataset.confirm;
  embedRevoke.textContent = "Turn off this embed";
}
/** Embed a frame and the screens it links to, or the whole file when frameId is "". */
async function openEmbed(frameId: string) {
  if (!embedPop.hidden && embedFor === frameId) return closeEmbed();
  const f = frameId ? frames.get(frameId) : null;
  if (frameId && !f) return;
  if (f ? !f.hasContent : ![...frames.values()].some((x) => x.hasContent)) return toast(`This ${f ? "frame" : "file"} is empty, so there's nothing to embed yet`);
  pop.hidden = true;
  closeExport();
  closeTrash();
  closeViewSheet();
  const res = await fetch(embedApi(frameId), { method: "POST" });
  if (!res.ok) return toast("Couldn't make an embed link. Try again.");
  closeEmbed();
  embedBase = location.origin + ((await res.json()) as { path: string }).path;
  embedFor = frameId;
  $("#embedTitle").textContent = f ? `Embed “${f.name}”` : "Embed this file";
  $("#embedText").textContent = f
    ? "people see this screen and the screens it links to, and nothing else in the file. To show every screen, use Export → Embed this file."
    : "people step through every screen in the file, including ones added later. To show one screen and its flow, select it and press I.";
  // the same four sizes the player offers; the canvas's own model stands in for its size
  const d = currentDevice();
  const own = d.id === "custom" ? null : d;
  embedDevice.innerHTML = EMBED_SIZES.map((s) => `<option value="${own && embedSizeOf(own) === s.id ? own.id : s.fallback}">${s.label}</option>`).join("");
  embedDevice.selectedIndex = EMBED_SIZES.findIndex((s) => s.id === embedSizeOf(d));
  embedTheme.value = themeMode === "both" ? "" : themeMode;
  syncEmbed();
  embedPop.hidden = false;
}
$("#exportEmbed").addEventListener("click", () => {
  closeExport();
  openEmbed("");
});
embedDevice.addEventListener("change", syncEmbed);
embedTheme.addEventListener("change", syncEmbed);
$("#embedCode").addEventListener("click", () => {
  const desktop = deviceById(embedDevice.value)?.kind === "desktop";
  copy(`<iframe src="${embedLink()}" width="100%" height="${desktop ? 520 : 720}" style="border:0" loading="lazy" allowfullscreen></iframe>`, "Copied the iframe tag");
});
embedRevoke.addEventListener("click", async () => {
  if (!embedFor) return;
  if (!embedRevoke.dataset.confirm) {
    embedRevoke.dataset.confirm = "";
    embedRevoke.textContent = "Click again: the link stops working everywhere";
    return;
  }
  const res = await fetch(embedApi(embedFor), { method: "DELETE" });
  closeEmbed();
  toast(res.ok ? "Embed turned off. Embedding again makes a new link." : "Couldn't turn the embed off. Try again.");
});

// deleting the file takes a second click within a few seconds
let armTimer = 0;
const deleteLabel = deleteFileBtn.firstChild!;
function disarmDelete() {
  clearTimeout(armTimer);
  delete deleteFileBtn.dataset.confirm;
  deleteLabel.textContent = "Delete this file";
}
deleteFileBtn.addEventListener("click", async () => {
  if (deleteFileBtn.dataset.confirm === undefined) {
    deleteFileBtn.dataset.confirm = "";
    deleteLabel.textContent = `Click again to delete “${file?.name ?? "this file"}”`;
    armTimer = window.setTimeout(disarmDelete, 4000);
    return;
  }
  disarmDelete();
  try {
    const t = await fileApi<Trashed>("", "DELETE");
    forgetFile(fileId);
    showTrashed(t);
  } catch (err) {
    failed(err);
  }
});

function showTrashed(t: Trashed) {
  closeTrash();
  closeExport();
  pop.hidden = true;
  const day = new Date(t.purgeAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  $("#trashedText").textContent = `“${t.name}” was deleted ${ago(t.deletedAt)}. Anyone with this link can restore it until ${day}. After that it's erased for good.`;
  trashedCard.hidden = false;
  document.title = `Deleted · ${t.name} · Divs & Spans`;
}
$("#restoreFileBtn").addEventListener("click", async () => {
  try {
    await fileApi("/restore", "POST");
  } catch (err) {
    return failed(err);
  }
  trashedCard.hidden = true;
  await load();
  toast("File restored");
});

// ---------- live sync ----------
let ws: WebSocket | null = null;
let retry = 0;
const device = matchMedia("(pointer: coarse)").matches ? "touch" : "desktop";
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/files/${fileId}/ws?v=${viewerId()}&d=${device}`);
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
      if (!trashPop.hidden) renderTrash();
    } else if (msg.type === "frame-deleted") {
      frames.delete(msg.id);
      renderAll();
      if (!trashPop.hidden) renderTrash();
    } else if (msg.type === "file-deleted") {
      showTrashed(msg);
    } else if (msg.type === "file-restored") {
      trashedCard.hidden = true;
      load();
    } else if (msg.type === "tokens") {
      tokensVersion = msg.version;
      renderAll();
    } else if (msg.type === "file") {
      setName(msg.name);
    } else comments.onMessage(msg);
  });
  ws.addEventListener("close", () => {
    setLive(false);
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  });
}
// pings double as engaged-time samples: active means the tab is visible and someone touched the canvas lately
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
let lastInput = Date.now();
function watchActivity(target: Document | Window) {
  for (const type of ["pointerdown", "keydown", "wheel"]) target.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
}
watchActivity(window);
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const active = document.visibilityState === "visible" && Date.now() - lastInput < ACTIVE_WINDOW_MS;
  ws.send(active ? "ping:active" : "ping");
}, 25000);
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
  // in the trash: keep the socket, so a restore from another browser brings the canvas back
  if (res.status === 410) return showTrashed(await res.json());
  trashedCard.hidden = true;
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
  await comments.load();
  renderAll();
}

addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  const fid = location.pathname.split("/")[3] || selectedFrame;
  if (id && fid) setTargets(id.split(",").map((elementId) => ({ frameId: fid, elementId })), true);
});

const comments = initComments({
  fileId,
  frameName: (id) => frames.get(id)?.name,
  frameOrder: () => frameOrder,
  primaryIframe,
  view: () => {
    const d = currentDevice();
    return { device: d.id === "custom" ? `custom` : d.id, w: d.w, h: d.h, theme: schemes()[0] };
  },
  revealScreenRect: (r, maxZ) => fitRect({ x: (r.x - cam.x) / cam.z, y: (r.y - cam.y) / cam.z, w: r.w / cam.z, h: r.h / cam.z }, maxZ),
  select,
  stopPicking: () => picking && setPicking(false),
  forEachDoc: (fn) => forEachDoc((doc) => fn(doc)),
});

applyCamera();
load().then(connect);
