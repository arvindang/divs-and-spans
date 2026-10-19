import { $, escapeHtml, prefs, rememberFile, wireCopyButtons, type Recent } from "./shared";

($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
wireCopyButtons();

const recent = prefs.get<Recent[]>("recent", []);
if (recent.length) {
  $("#recentHead").hidden = false;
  $("#recent").innerHTML = recent
    .map(
      (r) =>
        `<li><a href="/f/${r.id}"><span>${escapeHtml(r.name)}</span><time>${new Date(r.at).toLocaleDateString()}</time></a></li>`,
    )
    .join("");
}

$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = (new FormData(e.target as HTMLFormElement).get("name") as string).trim() || "Untitled";
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const file = (await res.json()) as { id: string; name: string };
  rememberFile(file.id, file.name);
  location.href = `/f/${file.id}`;
});
