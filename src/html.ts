import { parse } from "node-html-parser";
import { newElementId } from "./ids";

/** Make sure a frame is a full HTML document. Fragments get a minimal shell. */
export function normalizeDocument(html: string): string {
  let out = html.trim();
  if (!/<html[\s>]/i.test(out)) {
    out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${out}
</body>
</html>`;
  } else if (!/^<!doctype/i.test(out)) {
    out = `<!doctype html>\n${out}`;
  }
  return out;
}

const SKIP_TAGS = new Set(["script", "style", "template", "noscript", "br", "wbr", "source", "track", "meta", "link"]);

/**
 * Give every element inside <body> a stable `data-ds` id so any element or
 * group can be linked. Existing ids survive rewrites; duplicates (an agent
 * copy-pasting a block) get fresh ids. SVG internals are left alone.
 */
export async function stampElementIds(html: string): Promise<{ html: string; count: number }> {
  const seen = new Set<string>();
  let svgDepth = 0;
  let count = 0;

  const rewriter = new HTMLRewriter()
    .on("svg", {
      element(el) {
        svgDepth++;
        el.onEndTag(() => {
          svgDepth--;
        });
      },
    })
    .on("body *", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;
        // the <svg> itself gets an id (depth is already 1 when we see it); its children don't
        if (svgDepth > 1 || (svgDepth === 1 && tag !== "svg")) return;
        let id = el.getAttribute("data-ds");
        if (!id || seen.has(id) || !/^[a-z0-9_-]{2,32}$/i.test(id)) {
          do id = newElementId();
          while (seen.has(id));
          el.setAttribute("data-ds", id);
        }
        seen.add(id);
        count++;
      },
    });

  const out = await rewriter.transform(new Response(html)).text();
  return { html: out, count };
}

/** Inject the file's tokens.css (first, so frame styles win) and an optional forced theme. */
export async function renderForCanvas(
  html: string,
  opts: { tokensHref: string; theme?: "light" | "dark" },
): Promise<string> {
  const link = `<link rel="stylesheet" href="${opts.tokensHref}" data-ds-tokens>`;
  let injected = false;
  const rewriter = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (!injected) {
          el.prepend(link, { html: true });
          injected = true;
        }
      },
    })
    .on("html", {
      element(el) {
        if (opts.theme) {
          el.setAttribute("data-theme", opts.theme);
          el.setAttribute("style", `color-scheme: ${opts.theme};${el.getAttribute("style") ?? ""}`);
        }
      },
    });
  let out = await rewriter.transform(new Response(html)).text();
  if (!injected) out = out.replace(/<html[^>]*>/i, (m) => `${m}${link}`);
  return out;
}

export interface ResolvedElement {
  id: string;
  tag: string;
  outer_html: string;
  path: string[];
  truncated: boolean;
}

/** Find an element by its data-ds id and return its markup plus its ancestor path. */
export function resolveElement(html: string, elementId: string, maxLength = 12000): ResolvedElement | null {
  const root = parse(html, { comment: false });
  const el = root.querySelector(`[data-ds="${elementId}"]`);
  if (!el) return null;
  const path: string[] = [];
  let p = el.parentNode as typeof el | null;
  while (p && p.tagName) {
    const tag = p.tagName.toLowerCase();
    if (tag === "html") break;
    const ds = p.getAttribute?.("data-ds");
    const cls = p.getAttribute?.("class")?.split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    path.unshift(`${tag}${cls ? "." + cls : ""}${ds ? `[data-ds=${ds}]` : ""}`);
    p = p.parentNode as typeof el | null;
  }
  const outer = el.outerHTML;
  return {
    id: elementId,
    tag: el.tagName.toLowerCase(),
    outer_html: outer.length > maxLength ? outer.slice(0, maxLength) + "\n<!-- truncated -->" : outer,
    path,
    truncated: outer.length > maxLength,
  };
}

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)/gi;
const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
  "-apple-system", "blinkmacsystemfont",
]);

/** CSS the frame authored: <style> blocks and style="" attributes. Text content is ignored. */
function authoredCss(html: string): string {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]);
  return [...blocks, ...inline].join("\n");
}

/**
 * Consistency checks only — never taste. Returned to the agent so it can self-correct.
 */
export function lintFrame(html: string, rawTokensCss: string): string[] {
  const warnings: string[] = [];
  const tokensCss = rawTokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const css = authoredCss(html);
  const tokens = tokensCss.toLowerCase();
  const hasTokens = /--[a-z0-9-]+\s*:/i.test(tokensCss);

  if (!hasTokens) {
    warnings.push(
      "tokens.css has no custom properties yet. Once this frame's direction feels right, extract its palette, type and spacing into tokens.css with update_tokens (both color schemes), then reference them via var(--…).",
    );
  } else {
    const offSystem = new Set<string>();
    for (const m of css.matchAll(COLOR_RE)) {
      const v = m[0].toLowerCase().replace(/\s+/g, "");
      if (!tokens.replace(/\s+/g, "").includes(v)) offSystem.add(m[0]);
    }
    if (offSystem.size) {
      const list = [...offSystem].slice(0, 8).join(", ");
      warnings.push(
        `${offSystem.size} color value(s) not defined in tokens.css: ${list}. Use an existing token, or add it to tokens.css if it's a deliberate new color.`,
      );
    }

    const fonts = new Set<string>();
    for (const m of css.matchAll(/font-family\s*:\s*([^;}"]+)/gi)) {
      const value = m[1].trim();
      if (value.startsWith("var(")) continue;
      for (const fam of value.split(",")) {
        const name = fam.trim().replace(/^["']|["']$/g, "").toLowerCase();
        if (name && !GENERIC_FONTS.has(name) && !tokens.includes(name)) fonts.add(fam.trim());
      }
    }
    if (fonts.size) {
      warnings.push(`Font families not declared in tokens.css: ${[...fonts].slice(0, 5).join(", ")}.`);
    }

    const bothSchemes = /light-dark\(|prefers-color-scheme|\[data-theme/i.test(tokensCss);
    if (!bothSchemes) {
      warnings.push(
        "tokens.css defines only one color scheme. Define both, e.g. --surface: light-dark(<light>, <dark>) with `color-scheme: light dark` on :root.",
      );
    }
    if (!/var\(--/.test(css)) {
      warnings.push("This frame doesn't reference any tokens (var(--…)).");
    }
  }

  if (/<script[\s>]/i.test(html)) {
    warnings.push("Scripts don't run on the canvas; frames are static renders. Express states as separate frames.");
  }
  return warnings;
}
