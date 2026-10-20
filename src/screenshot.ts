import puppeteer, { type Browser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import { CHROME_CSS, CHROME_HTML } from "./chrome";
import { renderForCanvas } from "./html";

/**
 * PNGs of frames, rendered by Browser Run (headless Chromium) so they match
 * the canvas exactly. A PNG is what the canvas shows: the device's viewport,
 * or the whole page with H; the bezel and status bar with D; light, dark or
 * both side by side. Frames still never run script: each one sits in a
 * sandboxed iframe without allow-scripts, like on the canvas.
 */
export type Scheme = "light" | "dark";
export interface ShotView {
  /** Device viewport, CSS px. */
  w: number;
  h: number;
  kind: "phone" | "tablet" | "desktop";
  radius: number;
  safeTop: number;
  safeBottom: number;
  cutout: "" | "island" | "punch";
  chrome: boolean;
  full: boolean;
  schemes: Scheme[];
}

/** The canvas caps full-height frames at this; so do PNGs. */
const MAX_FRAME_H = 12000;
/** 2x unless the image would pass Chromium's capture limit or get too big to paste. */
const MAX_SIDE = 16384;
const MAX_PIXELS = 32_000_000;

const int = (v: string | null, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return v !== null && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** The canvas's current view, from query params (see pngQuery in web/canvas.ts). */
export function parseView(q: URLSearchParams): ShotView {
  const kind = q.get("kind");
  const cutout = q.get("cutout");
  const theme = q.get("theme");
  return {
    w: int(q.get("w"), 240, 3840, 1440),
    h: int(q.get("h"), 320, 2400, 900),
    kind: kind === "phone" || kind === "tablet" ? kind : "desktop",
    radius: int(q.get("radius"), 0, 80, 0),
    safeTop: int(q.get("st"), 0, 120, 0),
    safeBottom: int(q.get("sb"), 0, 60, 0),
    cutout: cutout === "island" || cutout === "punch" ? cutout : "",
    chrome: q.get("chrome") === "1",
    full: q.get("full") === "1",
    schemes: theme === "both" ? ["light", "dark"] : theme === "dark" ? ["dark"] : ["light"],
  };
}

/** A stable string for everything that changes the pixels, for cache keys. */
export const viewKey = (v: ShotView) =>
  [v.w, v.h, v.kind, v.radius, v.safeTop, v.safeBottom, v.cutout || "-", +v.chrome, +v.full, v.schemes.join("+")].join(".");

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The canvas's screen markup around each frame: same sizes, safe areas and chrome. */
async function pageHtml(html: string, tokens: string, v: ShotView, schemes: Scheme[], chrome: boolean): Promise<string> {
  const dressed = chrome && v.radius > 0;
  const bezel = v.kind === "tablet" ? 18 : 12;
  const pad = dressed ? bezel + 2 : 0;
  const screens = await Promise.all(schemes.map(async (scheme) => {
    const doc = await renderForCanvas(html, { tokensCss: tokens, theme: scheme, safe: { top: v.safeTop, bottom: v.safeBottom } });
    const style = `--radius:${v.radius}px;--safe-top:${v.safeTop}px;--safe-bottom:${v.safeBottom}px;width:${v.w}px;height:${v.h}px`;
    return `<div class="screen${dressed ? " device" : ""}" data-kind="${v.kind}" data-cutout="${v.cutout}" data-scheme="${scheme}" style="${style}">` +
      `<iframe sandbox="allow-same-origin" srcdoc="${attr(doc)}"></iframe>${CHROME_HTML}</div>`;
  }));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
.row { display: flex; align-items: flex-start; gap: ${dressed ? 80 : 40}px; padding: ${pad}px; width: max-content; }
.screen { position: relative; overflow: hidden; background: Canvas; }
.screen[data-scheme="light"] { color-scheme: light; }
.screen[data-scheme="dark"] { color-scheme: dark; }
.screen iframe { display: block; border: 0; width: 100%; height: 100%; }
${CHROME_CSS}</style></head><body><div class="row">${screens.join("")}</div></body></html>`;
}

/**
 * Runs in the page (as a string, so the bundler can't rewrite it): wait for
 * fonts and images, grow screens to the page height with H like the canvas
 * does, and return the box to capture (the elements' union for a crop).
 */
const LAYOUT = `async ({ full, deviceH, maxH, elements }) => {
  const frames = [...document.querySelectorAll(".screen iframe")];
  const settle = (doc) => Promise.race([
    Promise.all([doc.fonts.ready, ...[...doc.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))]),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  await Promise.all(frames.map((f) => settle(f.contentDocument)));
  if (full) {
    const h = Math.max(...frames.map((f) => Math.min(maxH, Math.max(deviceH, f.contentDocument.documentElement.scrollHeight))));
    for (const s of document.querySelectorAll(".screen")) s.style.height = h + "px";
    await Promise.all(frames.map((f) => settle(f.contentDocument)));
  }
  const row = document.querySelector(".row").getBoundingClientRect();
  if (!elements.length) return { x: 0, y: 0, w: Math.ceil(row.width), h: Math.ceil(row.height) };
  const doc = frames[0].contentDocument;
  const at = frames[0].getBoundingClientRect();
  const boxes = elements.map((id) => doc.querySelector('[data-ds="' + id + '"]')).filter(Boolean)
    .map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
  if (!boxes.length) return null;
  const x = Math.max(at.left, at.left + Math.min(...boxes.map((r) => r.left)));
  const y = Math.max(at.top, at.top + Math.min(...boxes.map((r) => r.top)));
  const right = Math.min(at.right, at.left + Math.max(...boxes.map((r) => r.right)));
  const bottom = Math.min(at.bottom, at.top + Math.max(...boxes.map((r) => r.bottom)));
  return { x: Math.floor(x), y: Math.floor(y), w: Math.ceil(right - x), h: Math.ceil(bottom - y) };
}`;

export interface Shot {
  png: Uint8Array;
  scale: 1 | 2;
}

async function shoot(page: Page, html: string, tokens: string, v: ShotView, elements: string[]): Promise<Shot> {
  // an element crop is one screen at full height, so an element below the fold is still there; no chrome over it
  const crop = elements.length > 0;
  const schemes = crop ? v.schemes.slice(0, 1) : v.schemes;
  await page.setViewport({ width: v.w * schemes.length + 200, height: v.h + 60, deviceScaleFactor: 2 });
  await page.setContent(await pageHtml(html, tokens, v, schemes, v.chrome && !crop), { waitUntil: "load", timeout: 20000 });
  const box = (await page.evaluate(`(${LAYOUT})(${JSON.stringify({ full: v.full || crop, deviceH: v.h, maxH: MAX_FRAME_H, elements })})`)) as
    { x: number; y: number; w: number; h: number } | null;
  if (!box || box.w < 1 || box.h < 1) throw new Error("Element not found in this frame");
  const scale = Math.max(box.w, box.h) * 2 <= MAX_SIDE && box.w * box.h * 4 <= MAX_PIXELS ? 2 : 1;
  // the viewport has to hold the whole capture; frames are sized in px, so this doesn't relayout them
  await page.setViewport({ width: Math.max(box.x + box.w, 1), height: Math.max(box.y + box.h, 1), deviceScaleFactor: scale });
  const png = await page.screenshot({ type: "png", omitBackground: true, clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  return { png: new Uint8Array(png), scale };
}

/** Reuse a warm browser when one is running; otherwise launch one that stays up for the next copy. */
async function getBrowser(endpoint: BrowserWorker): Promise<{ browser: Browser; launched: boolean }> {
  try {
    for (const s of await puppeteer.sessions(endpoint)) {
      try {
        return { browser: await puppeteer.connect(endpoint, s.sessionId), launched: false };
      } catch {
        // closed after it was listed
      }
    }
  } catch {}
  return { browser: await puppeteer.launch(endpoint, { keep_alive: KEEP_ALIVE_MS }), launched: true };
}
/** How long a launched browser idles before Browser Run closes it; billed time, if idle counts. */
export const KEEP_ALIVE_MS = 120_000;

/** For analytics: what one request cost in Browser Run terms. */
export interface ShooterStats {
  launched: boolean;
  renders: number;
  /** Connected time, from getting a browser to letting go of it. */
  ms: number;
}

export interface Shooter {
  shoot(html: string, tokens: string, view: ShotView, elements?: string[]): Promise<Shot>;
  close(): Promise<ShooterStats>;
}

/** One browser context for one request; a zip shoots every frame through the same page. */
export async function openShooter(endpoint: BrowserWorker): Promise<Shooter> {
  const started = Date.now();
  const { browser, launched } = await getBrowser(endpoint);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  let renders = 0;
  return {
    shoot: (html, tokens, view, elements = []) => (renders++, shoot(page, html, tokens, view, elements)),
    async close() {
      await context.close().catch(() => {});
      // disconnect, not close: other requests may share this browser
      await browser.disconnect().catch(() => {});
      return { launched, renders, ms: Date.now() - started };
    },
  };
}
