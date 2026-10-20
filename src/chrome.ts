/**
 * Device chrome (D): bezel, status bar, Dynamic Island or punch-hole, home
 * indicator. Drawn in CSS so it stays sharp at any zoom and needs no Apple
 * bezel images. The canvas (web/canvas.ts) and PNG screenshots (src/screenshot.ts)
 * both use this, so a PNG with D on matches the canvas. Environment-neutral:
 * plain strings only.
 *
 * Expects a `.screen` with data-kind, data-cutout, data-scheme, the `device`
 * class when chrome is on, and --radius / --safe-top / --safe-bottom set.
 */
export const CHROME_CSS = `
.screen.device {
  --bezel: 12px;
  --bezel-ring: 0 0 0 var(--bezel) #0b0b0d, 0 0 0 calc(var(--bezel) + 1.5px) #3c3c41;
  border-radius: var(--radius);
  box-shadow: var(--bezel-ring);
}
.screen.device[data-kind="tablet"] { --bezel: 18px; }
.chrome { display: none; position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.screen.device .chrome { display: block; }
.screen[data-scheme="light"] .chrome { color: #000; }
.screen[data-scheme="dark"] .chrome { color: #fff; }
.chrome .status {
  position: absolute;
  inset: 0 0 auto;
  height: var(--safe-top);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 34px 0 52px;
  font: 600 17px/1 -apple-system, "SF Pro Text", system-ui, sans-serif;
  letter-spacing: -0.01em;
}
.chrome .icons { display: flex; align-items: center; gap: 6px; }
.chrome svg { fill: currentColor; }
.screen[data-kind="phone"] .chrome .status { height: 54px; }
.screen[data-kind="tablet"] .chrome .status { padding: 0 20px; font-size: 13px; }
.screen[data-kind="tablet"] .chrome .icons { transform: scale(0.8); transform-origin: right center; }
.screen[data-cutout="punch"] .chrome .status { padding: 0 24px; font: 500 14px/1 system-ui, sans-serif; }
.chrome .cutout { position: absolute; left: 50%; translate: -50% 0; background: #000; display: none; }
.screen[data-cutout="island"] .chrome .cutout { display: block; top: 11px; width: 124px; height: 36px; border-radius: 20px; }
.screen[data-cutout="punch"] .chrome .cutout { display: block; top: 13px; width: 14px; height: 14px; border-radius: 50%; }
.chrome .home-bar {
  position: absolute;
  left: 50%;
  bottom: 8px;
  translate: -50% 0;
  width: 140px;
  height: 5px;
  border-radius: 3px;
  background: currentColor;
}
.screen[data-kind="tablet"] .chrome .home-bar { width: 320px; }
.screen[data-cutout="punch"] .chrome .home-bar { width: 108px; height: 4px; bottom: 10px; }
`;

const STATUS_ICONS = `<svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>` +
  `<svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 2.6a10 10 0 0 1 6.6 2.5l1.2-1.3A11.8 11.8 0 0 0 8 .8 11.8 11.8 0 0 0 .2 3.8l1.2 1.3A10 10 0 0 1 8 2.6zm0 3.6a6.3 6.3 0 0 1 4.2 1.6l1.2-1.3A8 8 0 0 0 8 4.4a8 8 0 0 0-5.4 2.1l1.2 1.3A6.3 6.3 0 0 1 8 6.2zm0 3.5a2.6 2.6 0 0 1 1.7.7L8 12.2l-1.7-1.8a2.6 2.6 0 0 1 1.7-.7z"/></svg>` +
  `<svg viewBox="0 0 28 13" width="27" height="13"><rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2.5" y="2.5" width="18" height="8" rx="2.2"/><path d="M26 4.5v4a2.2 2.2 0 0 0 0-4z" opacity=".45"/></svg>`;

export const CHROME_HTML = `<div class="chrome" aria-hidden="true">
  <div class="status"><span class="time">9:41</span><span class="icons">${STATUS_ICONS}</span></div>
  <i class="cutout"></i><i class="home-bar"></i>
</div>`;
