/**
 * Devices the canvas can preview frames on, in CSS px. iPhone and iPad widths
 * match the screen cutouts in Apple's 2026 product bezels; heights, corner
 * radii and safe areas are the devices' own.
 */
export type DeviceKind = "phone" | "tablet" | "desktop";

export interface Device {
  id: string;
  name: string;
  group: "iPhone" | "iPad" | "Mac" | "Android";
  kind: DeviceKind;
  w: number;
  h: number;
  /** Screen corner radius; 0 draws no chrome. */
  radius: number;
  safeTop: number;
  safeBottom: number;
  /** What sits at the top centre of the screen. */
  cutout?: "island" | "punch";
}

export const DEVICES: Device[] = [
  { id: "iphone-pro", name: "iPhone 17 / 18 Pro", group: "iPhone", kind: "phone", w: 402, h: 874, radius: 62, safeTop: 62, safeBottom: 34, cutout: "island" },
  { id: "iphone-air", name: "iPhone Air", group: "iPhone", kind: "phone", w: 420, h: 912, radius: 62, safeTop: 68, safeBottom: 34, cutout: "island" },
  { id: "iphone-pro-max", name: "iPhone Pro Max", group: "iPhone", kind: "phone", w: 440, h: 956, radius: 62, safeTop: 62, safeBottom: 34, cutout: "island" },
  { id: "ipad-mini", name: "iPad mini", group: "iPad", kind: "tablet", w: 744, h: 1133, radius: 22, safeTop: 24, safeBottom: 20 },
  { id: "ipad-air", name: "iPad Air 11″", group: "iPad", kind: "tablet", w: 820, h: 1180, radius: 18, safeTop: 24, safeBottom: 20 },
  { id: "ipad-pro", name: "iPad Pro 13″", group: "iPad", kind: "tablet", w: 1032, h: 1376, radius: 18, safeTop: 24, safeBottom: 20 },
  { id: "laptop", name: "Laptop", group: "Mac", kind: "desktop", w: 1280, h: 800, radius: 0, safeTop: 0, safeBottom: 0 },
  { id: "desktop", name: "Desktop", group: "Mac", kind: "desktop", w: 1440, h: 900, radius: 0, safeTop: 0, safeBottom: 0 },
  { id: "android", name: "Android phone", group: "Android", kind: "phone", w: 412, h: 915, radius: 36, safeTop: 40, safeBottom: 24, cutout: "punch" },
];

export const DEFAULT_BY_KIND: Record<DeviceKind, string> = { phone: "iphone-pro", tablet: "ipad-air", desktop: "desktop" };

export const deviceById = (id: string) => DEVICES.find((d) => d.id === id);

/** A frame pinned to a width belongs to a kind of device, not one model. */
export const kindForWidth = (w: number): DeviceKind => (w <= 600 ? "phone" : w <= 1100 ? "tablet" : "desktop");

export interface CustomSize {
  w: number;
  h: number;
  /** The device the drag started from; its chrome carries over while the width stays that kind. */
  base: string;
}

/** A dragged-to size, like Safari's responsive design mode. */
export function customDevice(c: CustomSize): Device {
  const kind = kindForWidth(c.w);
  const base = deviceById(c.base);
  const same = base && base.kind === kind ? base : null;
  return {
    id: "custom",
    name: `Custom ${c.w}×${c.h}`,
    group: base?.group ?? "Mac",
    kind,
    w: c.w,
    h: c.h,
    radius: same?.radius ?? 0,
    safeTop: same?.safeTop ?? 0,
    safeBottom: same?.safeBottom ?? 0,
    cutout: same?.cutout,
  };
}

/** The old width picker's values, so a saved preference carries over. */
export const deviceForLegacyWidth = (w: number) => (w === 1024 ? "laptop" : DEFAULT_BY_KIND[kindForWidth(w)]);

/**
 * The four screen sizes an embed offers. In a scaled-down embed one phone model looks like
 * another, so viewers switch kind; the model the embed link names stands in for its kind.
 */
export const EMBED_SIZES = [
  { id: "phone", label: "Phone", fallback: "iphone-pro", icon: `<rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/>` },
  { id: "tablet", label: "Tablet", fallback: "ipad-air", icon: `<rect x="2.5" y="1.5" width="11" height="13" rx="1.4"/>` },
  { id: "laptop", label: "Laptop", fallback: "laptop", icon: `<rect x="3" y="3" width="10" height="7" rx="1"/><path d="M1 12.5h14"/>` },
  { id: "desktop", label: "Desktop", fallback: "desktop", icon: `<rect x="1.5" y="2" width="13" height="8.5" rx="1"/><path d="M8 10.5v3M5 13.5h6"/>` },
] as const;
export type EmbedSize = (typeof EMBED_SIZES)[number]["id"];

export const embedSizeOf = (d: Device): EmbedSize =>
  d.kind === "phone" ? "phone" : d.kind === "tablet" ? "tablet" : d.id === "laptop" || d.w <= 1280 ? "laptop" : "desktop";
