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
const token = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

export function viewerId(): string {
  let id = prefs.get<string>("viewer", "");
  if (!/^[a-z0-9]{16}$/.test(id)) {
    id = token(16);
    prefs.set("viewer", id);
  }
  return id;
}

const ADJECTIVES = [
  "Curious", "Sleepy", "Brave", "Fuzzy", "Jolly", "Nimble", "Quiet", "Sunny", "Witty", "Zesty", "Breezy", "Cosmic",
  "Dapper", "Eager", "Fancy", "Gentle", "Humble", "Lucky", "Merry", "Plucky", "Rapid", "Snappy", "Spry", "Tidy",
  "Velvet", "Wobbly", "Bouncy", "Chipper", "Crafty", "Dreamy", "Fearless", "Giddy", "Hasty", "Keen", "Lively",
  "Mellow", "Peppy", "Quirky", "Rosy", "Sparkly", "Swift", "Thrifty", "Upbeat", "Vivid", "Whimsical", "Zany",
];
const ANIMALS = [
  "Capybara", "Otter", "Narwhal", "Axolotl", "Pangolin", "Quokka", "Platypus", "Hedgehog", "Lemur", "Puffin",
  "Wombat", "Ocelot", "Alpaca", "Badger", "Chinchilla", "Dingo", "Ferret", "Gecko", "Heron", "Ibis", "Jackal",
  "Koala", "Llama", "Marmot", "Newt", "Okapi", "Penguin", "Raccoon", "Salamander", "Tapir", "Walrus", "Yak",
  "Zebra", "Armadillo", "Beaver", "Cheetah", "Dolphin", "Flamingo", "Gibbon", "Hamster", "Kiwi", "Manatee",
  "Mongoose", "Owl", "Panda", "Seal", "Sloth", "Toucan",
];
const pick = <T,>(list: T[]) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

/**
 * Who you are on comments, without accounts: a random id and a funny name kept
 * in this browser, like an anonymous animal in a shared doc. `secret` never
 * leaves except to prove a comment is yours when you edit or delete it.
 * Clearing storage or switching device makes you someone new.
 */
export interface Commenter {
  id: string;
  secret: string;
  name: string;
}
export function commenter(): Commenter {
  let me = prefs.get<Commenter | null>("commenter", null);
  if (!me || !/^[a-z0-9]{16}$/.test(me.id) || !/^[a-z0-9]{32}$/.test(me.secret) || !me.name) {
    me = { id: token(16), secret: token(32), name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}` };
    prefs.set("commenter", me);
  }
  return me;
}
export function renameCommenter(name: string): Commenter {
  const me = { ...commenter(), name: name.replace(/\s+/g, " ").trim().slice(0, 40) || commenter().name };
  prefs.set("commenter", me);
  return me;
}
/** A steady color per author, so the same person reads the same everywhere. */
export function authorColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 58% 46%)`;
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
