import { $, escapeHtml, forgetFile, prefs, rememberFile, toast, wireCopyButtons, type Recent } from "./shared";

($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
wireCopyButtons();

function renderRecent() {
  const recent = prefs.get<Recent[]>("recent", []);
  $("#recentHead").hidden = !recent.length;
  $("#recent").innerHTML = recent
    .map(
      (r) =>
        `<li><a href="/f/${r.id}"><span>${escapeHtml(r.name)}</span><time>${new Date(r.at).toLocaleDateString()}</time></a>` +
        `<button class="forget" data-id="${r.id}" title="Remove from this list (the file isn't deleted)" aria-label="Remove ${escapeHtml(r.name)} from recent">×</button></li>`,
    )
    .join("");
}
renderRecent();
// tidying the list never touches the file: delete a file from its canvas (Trash)
$("#recent").addEventListener("click", (e) => {
  const id = (e.target as Element).closest<HTMLElement>(".forget")?.dataset.id;
  if (!id) return;
  forgetFile(id);
  renderRecent();
  toast("Removed from recent. The file itself is still there.");
});

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
