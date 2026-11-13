import { escapeHtml } from "./shared";

/**
 * A small, safe markdown renderer for frame notes: headings, paragraphs, lists
 * (nested, with task boxes), quotes, code, tables, rules, links and emphasis.
 * Everything is escaped first; links keep only http(s), mailto, #fragments and paths.
 */

const safeHref = (url: string) => (/^(https?:|mailto:|#|\/)/i.test(url.trim()) ? url.trim() : null);

/** GitHub issue and PR links read better as owner/repo#123. */
const shortUrl = (url: string) => {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[#?].*)?$/);
  return m ? `${m[1]}#${m[2]}` : url.replace(/^https?:\/\/(www\.)?/, "");
};

function inline(src: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = src.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, url) => {
    const href = safeHref(url);
    if (!href) return all;
    return hold(`<a href="${escapeHtml(href)}">${inline(text)}</a>`);
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => hold(`<a href="${escapeHtml(url)}">${escapeHtml(shortUrl(url))}</a>`));
  s = escapeHtml(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])|(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function list(lines: string[]): string {
  // nest by indent: each item opens a list at its depth, or continues the one there
  let out = "";
  const stack: { indent: number; tag: string }[] = [];
  for (const line of lines) {
    const m = line.match(LIST);
    if (!m) {
      out += `<br>${inline(line.trim())}`;
      continue;
    }
    const indent = m[1].replace(/\t/g, "  ").length;
    const tag = /\d/.test(m[2]) ? "ol" : "ul";
    while (stack.length && indent < stack.at(-1)!.indent) out += `</li></${stack.pop()!.tag}>`;
    if (!stack.length || indent > stack.at(-1)!.indent) {
      stack.push({ indent, tag });
      out += `<${tag}>`;
    } else out += "</li>";
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    out += task
      ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2])}`
      : `<li>${inline(m[3])}`;
  }
  while (stack.length) out += `</li></${stack.pop()!.tag}>`;
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
      const td = (tag: string, c: string, j: number) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c)}</${tag}>`;
      let html = `<table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>`;
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) {
        html += `<tr>${cells(lines[i]).map((c, j) => td("td", c, j)).join("")}</tr>`;
      }
      i--;
      out.push(`${html}</tbody></table>`);
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const body: string[] = [];
      // a list runs until a blank line followed by something that isn't a list item
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          if (LIST.test(lines[i + 1] ?? "")) continue;
          break;
        }
        if (!LIST.test(l) && !/^\s+\S/.test(l)) break;
        body.push(l);
      }
      i--;
      out.push(list(body));
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("\n");
}
