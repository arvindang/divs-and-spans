const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random id from a-z0-9. File ids are long enough to act as capability URLs pre-auth. */
export function randomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const newFileId = () => randomId(14);
export const newFrameId = () => randomId(8);
export const newElementId = () => randomId(6);
export const newLockToken = () => randomId(20);

export interface ParsedLink {
  fileId: string;
  frameId?: string;
  elementId?: string;
  /** Every element in the hash: #a,b,c points at several elements in one frame. */
  elementIds?: string[];
}

/**
 * Accepts any of:
 *   https://host/f/<file>
 *   https://host/f/<file>/<frame>
 *   https://host/f/<file>/<frame>#<element>
 *   https://host/f/<file>/<frame>#<element>,<element>,…
 *   <file>  |  <file>/<frame>  |  <file>/<frame>#<element>
 */
export function parseLink(input: string): ParsedLink | null {
  const s = input.trim().replace(/\?[^#]*/, "");
  const m = s.match(/(?:^|\/f\/)([a-z0-9]{6,32})(?:\/([a-z0-9]{4,32}))?\/?(?:#([a-z0-9_-]{2,32}(?:,[a-z0-9_-]{2,32})*))?\/?$/i);
  if (!m) return null;
  const elementIds = m[3]?.split(",");
  return { fileId: m[1], frameId: m[2] || undefined, elementId: elementIds?.[0], elementIds };
}

export const links = (origin: string) => ({
  file: (fileId: string) => `${origin}/f/${fileId}`,
  frame: (fileId: string, frameId: string) => `${origin}/f/${fileId}/${frameId}`,
  element: (fileId: string, frameId: string, elementId: string) => `${origin}/f/${fileId}/${frameId}#${elementId}`,
  mcp: () => `${origin}/mcp`,
});
