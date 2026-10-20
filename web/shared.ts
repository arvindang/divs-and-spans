export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

let toastTimer: number | undefined;
export function toast(html: string, ms = 2200) {
  const el = $("#toast");
  el.innerHTML = html;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), ms);
}

export async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  // several lines (e.g. multiple element links) won't fit the toast: the label says how many
  toast(text.includes("\n") ? escapeHtml(label) : `${escapeHtml(label)} <code>${escapeHtml(text)}</code>`);
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** localStorage is a per-viewer convenience only; it can throw or be empty. */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`ds:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`ds:${key}`, JSON.stringify(value));
    } catch {}
  },
};

/**
 * Anonymous, random id for counting weekly viewers. Nothing personal goes into it.
 * If storage is blocked it changes per page load, which only overcounts.
 */
export function viewerId(): string {
  let id = prefs.get<string>("viewer", "");
  if (!/^[a-z0-9]{16}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    prefs.set("viewer", id);
  }
  return id;
}

export interface Recent {
  id: string;
  name: string;
  at: number;
}
export function rememberFile(id: string, name: string) {
  const list = prefs.get<Recent[]>("recent", []).filter((r) => r.id !== id);
  list.unshift({ id, name, at: Date.now() });
  prefs.set("recent", list.slice(0, 12));
}

/** Wire every [data-copy="<inputId>"] button to copy that input's value. */
export function wireCopyButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.copy!) as HTMLInputElement;
      copy(input.value);
    });
  });
}
