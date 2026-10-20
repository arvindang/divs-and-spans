/**
 * Flows: links between frames, written as plain HTML so the agent owns them.
 *   <a href="#<frame>">            <button data-to="<frame>">
 *   <a href="#<frame>/<element>">  <button data-to="<frame>/<element>">
 * A full frame link (/f/<file>/<frame>#<element>) works too. Shared by the
 * worker (node-html-parser) and the canvas (DOM), so it only needs getAttribute.
 */
export interface FlowRef {
  frame: string;
  element?: string;
  /** A plain #id: may just be an in-page anchor rather than a frame. */
  bare: boolean;
}

interface LinkNode {
  getAttribute(name: string): string | null | undefined;
  textContent: string | null;
}
interface LinkRoot<E extends LinkNode> {
  querySelectorAll(selector: string): ArrayLike<E>;
}

export interface FlowLink<E> {
  el: E;
  /** The source element's data-ds id. */
  element: string;
  text: string;
  value: string;
  ref: FlowRef;
}

export const FLOW_SELECTOR = "a[href], [data-to]";

export function parseFlowRef(value: string, fileId: string, fromHref: boolean): FlowRef | null {
  const v = value.trim();
  const full = v.match(/\/f\/([a-z0-9]+)\/([a-z0-9]{4,32})\/?(?:#([a-z0-9_-]{2,32}))?/i);
  if (full) return full[1] === fileId ? { frame: full[2], element: full[3], bare: false } : null;
  if (fromHref && !v.startsWith("#")) return null; // external, mailto:, relative paths
  const m = v.match(/^#?([a-z0-9]{4,32})(?:[/#]([a-z0-9_-]{2,32}))?$/i);
  if (!m) return null;
  return { frame: m[1], element: m[2], bare: fromHref && !m[2] };
}

/** Every link in a frame that could point at another frame, plus the ids an in-page #anchor could hit. */
export function linksIn<E extends LinkNode>(root: LinkRoot<E>, fileId: string) {
  const links: FlowLink<E>[] = [];
  const els = root.querySelectorAll(FLOW_SELECTOR);
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const to = el.getAttribute("data-to");
    const value = to ?? el.getAttribute("href") ?? "";
    const ref = parseFlowRef(value, fileId, to == null);
    const element = el.getAttribute("data-ds");
    if (!ref || !element) continue;
    const text = (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    links.push({ el, element, text: text.length > 60 ? text.slice(0, 59) + "…" : text, value, ref });
  }
  const anchors = new Set<string>();
  const named = root.querySelectorAll("[id], [name]");
  for (let i = 0; i < named.length; i++) {
    for (const attr of ["id", "name"]) {
      const v = named[i].getAttribute(attr);
      if (v) anchors.add(v);
    }
  }
  return { links, anchors };
}

export type Resolved = { kind: "edge"; to: string; toElement?: string } | { kind: "dead" } | null;

/** An edge to another frame, a dead link, or nothing to draw (in-page anchor, self link). */
export function resolveLink(ref: FlowRef, from: string, hasFrame: (id: string) => boolean, anchors: Set<string>): Resolved {
  if ((ref.bare && anchors.has(ref.frame)) || ref.frame === from) return null;
  if (!hasFrame(ref.frame)) return { kind: "dead" };
  return { kind: "edge", to: ref.frame, toElement: ref.element };
}
