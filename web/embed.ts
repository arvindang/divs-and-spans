// The embed player: /e/<object>/<key>. Read-only, one device, click-through along the
// file's flows, live as the agent rewrites frames. It never learns the file id.
import { CHROME_CSS, CHROME_HTML } from "../src/chrome";
import { DEFAULT_BY_KIND, EMBED_SIZES, deviceById, embedSizeOf, kindForWidth, type Device, type EmbedSize } from "./devices";

interface EmbedFrame {
  id: string;
  name: string;
  version: number;
  width: number | null;
}
interface EmbedFlow {
  from: string;
  element: string;
  to: string;
  toElement: string | null;
}
interface EmbedState {
  name: string;
  start: string;
  tokensVersion: number;
  frames: EmbedFrame[];
  flows: EmbedFlow[];
}
type Scheme = "light" | "dark";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const base = location.pathname.replace(/\/$/, "");
const params = new URLSearchParams(location.search);
const stage = $("stage");
const fit = $("fit");
const screen = $("screen");
const message = $("message");
const framed = window.top !== window;
/** A tab the player opened for itself because its host iframe doesn't allow full screen. */
const expandedTab = !framed && params.get("expanded") === "1";

let state: EmbedState | null = null;
let current = "";
let pendingElement: string | null = null;
let scheme: Scheme = params.get("theme") === "dark" || params.get("theme") === "light"
  ? (params.get("theme") as Scheme)
  : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let hints = false;
let device: Device = deviceById(params.get("device") ?? "") ?? deviceById(DEFAULT_BY_KIND.desktop)!;
/** One device per size; the embed link's model stands in for its own size. */
const sizeDevices = Object.fromEntries(EMBED_SIZES.map((s) => [s.id, deviceById(s.fallback)!])) as Record<EmbedSize, Device>;
sizeDevices[embedSizeOf(device)] = device;

const chromeStyle = document.createElement("style");
chromeStyle.textContent = CHROME_CSS;
document.head.prepend(chromeStyle);
screen.innerHTML = CHROME_HTML;

// ---------- layout ----------
function layout() {
  const d = device;
  const chrome = d.radius > 0;
  screen.classList.toggle("device", chrome);
  screen.dataset.kind = d.kind;
  screen.dataset.cutout = d.cutout ?? "";
  screen.dataset.scheme = scheme;
  screen.style.setProperty("--radius", `${d.radius}px`);
  screen.style.setProperty("--safe-top", `${d.safeTop}px`);
  screen.style.setProperty("--safe-bottom", `${d.safeBottom}px`);
  screen.style.width = `${d.w}px`;
  screen.style.height = `${d.h}px`;
  const bezel = chrome ? (d.kind === "tablet" ? 18 : 12) + 1.5 : 0;
  const pad = 12;
  const s = Math.min(1, (stage.clientWidth - pad * 2) / (d.w + bezel * 2), (stage.clientHeight - pad * 2) / (d.h + bezel * 2));
  fit.style.width = `${(d.w + bezel * 2) * s}px`;
  fit.style.height = `${(d.h + bezel * 2) * s}px`;
  screen.style.left = screen.style.top = `${bezel * s}px`;
  screen.style.transform = `scale(${s})`;
}
new ResizeObserver(layout).observe(stage);

function setScheme(next: Scheme) {
  scheme = next;
  document.documentElement.dataset.scheme = scheme;
  layout();
  if (current) load(current, true);
}

// ---------- frames ----------
const frameById = (id: string) => state?.frames.find((f) => f.id === id);

const FRAME_CSS = `
[data-ds-hot] { cursor: pointer; }
html[data-ds-hints] [data-ds-hot] {
  outline: 2px solid rgb(79 70 229 / 0.7) !important;
  outline-offset: 2px;
  background-color: rgb(79 70 229 / 0.1) !important;
  transition: outline-color 0.2s;
}`;

/** Load a frame behind the current one and swap on load, so live updates don't flash. */
function load(id: string, keepScroll = false) {
  const f = frameById(id);
  if (!f || !state) return;
  const src = `${base}/frames/${f.id}?theme=${scheme}&v=${f.version}&t=${state.tokensVersion}`;
  const old = screen.querySelector<HTMLIFrameElement>("iframe:not([data-loading])");
  if (old?.dataset.src === src) return;
  screen.querySelectorAll("iframe[data-loading]").forEach((n) => n.remove());
  const scroll = keepScroll && old?.dataset.frame === id ? old.contentWindow?.scrollY ?? 0 : 0;
  const next = document.createElement("iframe");
  // allow-scripts only so Safari runs our listeners; the frame's CSP (script-src 'none') blocks its own scripts
  next.setAttribute("sandbox", "allow-same-origin allow-scripts");
  next.title = f.name;
  next.dataset.src = src;
  next.dataset.frame = id;
  next.dataset.loading = "";
  next.style.colorScheme = scheme;
  next.addEventListener("load", () => {
    instrument(next, id);
    delete next.dataset.loading;
    old?.remove();
    if (scroll) next.contentWindow?.scrollTo(0, scroll);
    if (pendingElement) {
      next.contentDocument?.querySelector(`[data-ds="${CSS.escape(pendingElement)}"]`)?.scrollIntoView({ block: "center" });
      pendingElement = null;
    }
  }, { once: true });
  next.src = src;
  screen.prepend(next);
}

function instrument(iframe: HTMLIFrameElement, frameId: string) {
  const doc = iframe.contentDocument;
  if (!doc || !state) return;
  const style = doc.createElement("style");
  style.textContent = FRAME_CSS;
  (doc.head || doc.documentElement).append(style);
  applySafeArea(doc);
  doc.documentElement.toggleAttribute("data-ds-hints", hints);
  const out = new Map<string, EmbedFlow>();
  for (const fl of state.flows) {
    if (fl.from !== frameId || !frameById(fl.to)) continue;
    out.set(fl.element, fl);
    doc.querySelector(`[data-ds="${CSS.escape(fl.element)}"]`)?.setAttribute("data-ds-hot", "");
  }
  doc.addEventListener("click", (e) => {
    e.preventDefault(); // designs are static: only flows navigate
    const hot = (e.target as Element).closest?.("[data-ds-hot]");
    const fl = hot && out.get(hot.getAttribute("data-ds")!);
    if (fl) go(fl.to, fl.toElement);
    else flashHints(doc);
  }, true);
  doc.addEventListener("submit", (e) => e.preventDefault(), true);
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("pointerdown", () => setMenu(false));
}

/** Frames pad around the status bar and home indicator with var(--ds-safe-top/bottom). */
function applySafeArea(doc: Document) {
  let style = doc.querySelector<HTMLStyleElement>("style[data-ds-device]");
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute("data-ds-device", "");
    (doc.head || doc.documentElement).append(style);
  }
  const chrome = device.radius > 0;
  style.textContent = `:root { --ds-safe-top: ${chrome ? device.safeTop : 0}px; --ds-safe-bottom: ${chrome ? device.safeBottom : 0}px; }`;
}

// ---------- screen size ----------
const sizesEl = $("sizes");
sizesEl.innerHTML = EMBED_SIZES.map(
  (s) => `<button class="btn" role="radio" data-size="${s.id}" title="${s.label} ([ and ] step)" aria-label="${s.label}"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${s.icon}</svg></button>`,
).join("");
function renderSizes() {
  const on = embedSizeOf(device);
  sizesEl.querySelectorAll<HTMLElement>("[data-size]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.size === on)));
}
function setSize(id: EmbedSize) {
  device = sizeDevices[id];
  layout();
  renderSizes();
  screen.querySelectorAll("iframe").forEach((f) => f.contentDocument && applySafeArea(f.contentDocument));
}
function stepSize(by: number) {
  const i = EMBED_SIZES.findIndex((s) => s.id === embedSizeOf(device));
  const next = EMBED_SIZES[Math.max(0, Math.min(EMBED_SIZES.length - 1, i + by))];
  if (next) setSize(next.id);
}
sizesEl.addEventListener("click", (e) => {
  const id = (e.target as Element).closest<HTMLElement>("[data-size]")?.dataset.size as EmbedSize | undefined;
  if (id) setSize(id);
});

// ---------- the ⋯ menu on narrow embeds ----------
const bar = $("bar");
const moreBtn = $("moreBtn");
function setMenu(open: boolean) {
  bar.classList.toggle("open", open);
  moreBtn.setAttribute("aria-expanded", String(open));
}
moreBtn.addEventListener("click", () => setMenu(!bar.classList.contains("open")));
document.addEventListener("pointerdown", (e) => {
  if (bar.classList.contains("open") && !bar.contains(e.target as Node)) setMenu(false);
});

/** A click that isn't on a link shows what is, like a prototype's hotspot hints. */
let flashTimer = 0;
function flashHints(doc: Document) {
  if (hints || !doc.querySelector("[data-ds-hot]")) return;
  doc.documentElement.setAttribute("data-ds-hints", "");
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => doc.documentElement.toggleAttribute("data-ds-hints", hints), 700);
}

function go(id: string, element: string | null = null) {
  if (!frameById(id)) return;
  current = id;
  pendingElement = element;
  load(id);
  render();
}

/** ← and → step through the screens in order, as the "2 / 3" count promises; links jump anywhere. */
const index = () => state?.frames.findIndex((x) => x.id === current) ?? -1;
function step(by: number) {
  const next = state?.frames[index() + by];
  if (next) go(next.id);
}

function render() {
  const f = frameById(current);
  $("frameName").textContent = f?.name ?? "";
  const n = state?.frames.length ?? 0;
  $("frameCount").textContent = n > 1 ? `${index() + 1} / ${n}` : "";
  $<HTMLButtonElement>("backBtn").disabled = index() <= 0;
  $<HTMLButtonElement>("fwdBtn").disabled = index() < 0 || index() >= n - 1;
  $("hintBtn").hidden = !state?.flows.some((fl) => frameById(fl.to));
  $("hintBtn").setAttribute("aria-pressed", String(hints));
  document.title = f && state ? `${f.name} · ${state.name}` : document.title;
}

function showMessage(title: string, text: string) {
  fit.hidden = true;
  message.hidden = false;
  message.innerHTML = `<b></b><span></span>`;
  message.querySelector("b")!.textContent = title;
  message.querySelector("span")!.textContent = text;
  $("frameName").textContent = "";
  $("frameCount").textContent = "";
}

// ---------- state + live ----------
async function refresh() {
  const res = await fetch(`${base}/state`, { cache: "no-store" });
  // gone for good: stop reconnecting
  if (res.status === 404) return (gone = true), showMessage("This embed is off", "Whoever shared it turned it off, or the link is incomplete.");
  if (res.status === 410) return showMessage("This design was deleted", "Its file is in the trash. It comes back here if someone restores it.");
  if (!res.ok) return showMessage("Couldn't load this design", "Try again in a moment.");
  const first = !state;
  state = (await res.json()) as EmbedState;
  fit.hidden = false;
  message.hidden = true;
  if (first && !params.get("device")) {
    const w = frameById(state.start)?.width;
    if (w) device = sizeDevices[embedSizeOf(deviceById(DEFAULT_BY_KIND[kindForWidth(w)])!)];
    layout();
    renderSizes();
  }
  if (!state.frames.length) return showMessage("Nothing here yet", "This frame is still being designed.");
  if (!frameById(current)) go(state.start);
  else {
    load(current, true);
    render();
  }
}

let refreshTimer = 0;
let gone = false;
let retry = 1000;
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws`);
  let ping = 0;
  ws.addEventListener("open", () => {
    retry = 1000;
    ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 250);
  });
  ws.addEventListener("close", (e) => {
    clearInterval(ping);
    if (e.code === 4004) return void refresh();
    if (gone) return;
    // a dropped socket may have missed changes: catch up once it's back
    setTimeout(() => {
      connect();
      refresh();
    }, retry);
    retry = Math.min(retry * 2, 30000);
  });
}

// ---------- controls ----------
function onKey(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "t" || e.key === "T") setScheme(scheme === "dark" ? "light" : "dark");
  else if (e.key === "h" || e.key === "H") toggleHints();
  else if (e.key === "f" || e.key === "F") toggleExpand();
  else if (e.key === "[" || e.key === "]") stepSize(e.key === "]" ? 1 : -1);
  else if (e.key === "Escape" && bar.classList.contains("open")) setMenu(false);
  else return;
  e.preventDefault();
}

function toggleHints() {
  hints = !hints;
  screen.querySelectorAll("iframe").forEach((f) => f.contentDocument?.documentElement.toggleAttribute("data-ds-hints", hints));
  render();
}

/**
 * Expand is full screen when the host iframe allows it (Esc or F collapses it). Otherwise it
 * opens the player in its own tab, where the same button closes that tab to go back to the doc.
 */
const expandBtn = $("expandBtn");
function toggleExpand() {
  if (expandedTab) return closeTab();
  if (document.fullscreenElement) return void document.exitFullscreen();
  if (!framed) return;
  if (document.fullscreenEnabled) document.documentElement.requestFullscreen().catch(openTab);
  else openTab();
}
const tabLink = () => {
  const p = new URLSearchParams(params);
  p.set("theme", scheme);
  p.set("expanded", "1");
  return `${location.origin}${base}?${p}`;
};
/**
 * Full screen refused (the host iframe doesn't allow it): open the player in its own tab.
 * A blocked popup fails silently, so if this page is still in front a moment later,
 * offer a plain link, which a click always follows.
 */
function openTab() {
  const a = document.createElement("a");
  a.href = tabLink();
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
  setTimeout(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      showToast("This page doesn't allow full screen here. ", { href: tabLink(), text: "Open in a new tab ↗" });
    }
  }, 400);
}
function closeTab() {
  // some hosts (in-app browsers) open "new tab" links in place: step back to the doc instead
  if (history.length > 1) return history.back();
  window.close();
  // browsers only let a page close a tab that was opened for it; otherwise say how to get back
  setTimeout(() => {
    expandBtn.hidden = true;
    showToast("Close this tab to go back to the doc");
  }, 200);
}
function syncExpand() {
  const shrink = expandedTab || !!document.fullscreenElement;
  expandBtn.hidden = !framed && !expandedTab;
  expandBtn.setAttribute("aria-pressed", String(shrink));
  const label = expandedTab ? "Close and go back to the doc" : shrink ? "Exit full screen" : "Full screen";
  expandBtn.setAttribute("aria-label", label);
  $("expandLbl").textContent = expandedTab ? "Back to the doc" : shrink ? "Exit full screen" : "Full screen";
  expandBtn.title = `${label} (${shrink && !expandedTab ? "F or Esc" : "F"})`;
}
document.addEventListener("fullscreenchange", syncExpand);
syncExpand();

let toastTimer = 0;
function showToast(text: string, link?: { href: string; text: string }) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = text;
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    a.addEventListener("click", () => (t!.hidden = true));
    t.append(a);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t!.hidden = true), link ? 8000 : 3000);
}

addEventListener("keydown", onKey);
$("backBtn").addEventListener("click", () => step(-1));
$("fwdBtn").addEventListener("click", () => step(1));
$("themeBtn").addEventListener("click", () => setScheme(scheme === "dark" ? "light" : "dark"));
$("hintBtn").addEventListener("click", toggleHints);
expandBtn.addEventListener("click", toggleExpand);

document.documentElement.dataset.scheme = scheme;
layout();
renderSizes();
refresh();
connect();
