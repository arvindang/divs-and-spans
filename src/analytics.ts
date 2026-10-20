import type { Env } from "./index";

/**
 * Product analytics in Workers Analytics Engine (dataset divs_and_spans_events).
 * Every event uses the same columns so one query shape fits all of them:
 *
 *   blob1 event    "tool" | "connect" | "session" | "create" | "export" | "png" | "browser"
 *   blob2 name     tool name · MCP client name · "canvas" · "web" · png "copy" | "download" | "zip" · browser "launch" | "reuse"
 *   blob3 file     hashed file id ("" when there is none)
 *   blob4 actor    MCP client (User-Agent product) · anonymous viewer id (sessions, png)
 *   blob5 detail   tool outcome/variant · device class · exported frame count · png "frame" | "element" | frame count | "error"
 *   blob6 country
 *   double1 ms     tool latency · session length · png request time · browser connected time
 *   double2        html bytes written · engaged ms · zip or png bytes
 *   double3        lint warnings · png and browser renders (0 when every PNG came from cache)
 *   index1         hashed file id, so sampling (if it ever kicks in) is per file
 *
 * File ids are capability URLs (anyone with one can edit), so they are hashed
 * before they leave the Durable Object. Frame HTML and prompts are never recorded.
 */
export interface AnalyticsEvent {
  event: "tool" | "connect" | "session" | "create" | "export" | "png" | "browser";
  name: string;
  fileId?: string;
  actor?: string;
  detail?: string;
  country?: string;
  ms?: number;
  size?: number;
  warnings?: number;
  /** double3 for events that aren't tool calls (png renders). */
  count?: number;
}

const hashes = new Map<string, string>();

async function hashFileId(fileId: string): Promise<string> {
  let h = hashes.get(fileId);
  if (!h) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ds:${fileId}`));
    h = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hashes.size > 5000) hashes.clear();
    hashes.set(fileId, h);
  }
  return h;
}

/** Fire and forget. A missing binding (tests, a fork without the dataset) is a no-op. */
export async function track(env: Env, e: AnalyticsEvent): Promise<void> {
  if (!env.EVENTS) return;
  try {
    const file = e.fileId ? await hashFileId(e.fileId) : "";
    env.EVENTS.writeDataPoint({
      blobs: [e.event, e.name, file, (e.actor ?? "").slice(0, 96), e.detail ?? "", e.country ?? ""],
      doubles: [e.ms ?? 0, e.size ?? 0, e.warnings ?? e.count ?? 0],
      indexes: [file],
    });
  } catch {}
}

/** "claude-code/1.2.3 (darwin)" → "claude-code". Good enough to tell clients apart in a stateless server. */
export const clientFromUserAgent = (ua: string | null) =>
  (ua ?? "").trim().split(/[\s/]/)[0].toLowerCase().slice(0, 48) || "unknown";

export const countryOf = (request: Request) => (request.cf?.country as string | undefined) ?? "";
