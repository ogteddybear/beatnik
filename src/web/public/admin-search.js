(() => {
  const form = document.getElementById("admin-search");
  if (!form) return;
  const status = document.getElementById("event-search-status");
  const rows = document.getElementById("event-search-results");
  const more = document.getElementById("event-search-more");
  let query = "",
    before = null,
    controller,
    version = 0;
  async function search(append) {
    const run = ++version;
    controller?.abort();
    controller = new AbortController();
    const params = new URLSearchParams({ q: query });
    if (append && before) params.set("before", String(before));
    more.disabled = true;
    status.textContent = "Searching…";
    try {
      const response = await fetch(`/api/admin/search?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `Search unavailable (${response.status}). Check your session and try again.`,
        );
      const data = await response.json();
      if (run !== version) return;
      if (!append) rows.replaceChildren();
      for (const event of data.events) {
        const row = document.createElement("tr");
        for (const value of [
          new Date(event.created_at).toISOString(),
          event.guild_id,
          event.username,
          event.track_name,
          event.event_type,
          event.action,
        ]) {
          const cell = document.createElement("td");
          cell.textContent = value ?? "—";
          row.append(cell);
        }
        rows.append(row);
      }
      before = data.nextBefore;
      more.hidden = before === null;
      status.textContent = rows.children.length
        ? `${rows.children.length} results loaded.`
        : "No matching events.";
    } catch (error) {
      if (run === version && error.name !== "AbortError") status.textContent = error.message;
    } finally {
      if (run === version) more.disabled = false;
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    query = document.getElementById("event-search-query").value.trim();
    if (!query) return;
    before = null;
    more.hidden = true;
    rows.replaceChildren();
    void search(false);
  });
  more.addEventListener("click", () => {
    if (before !== null) void search(true);
  });
})();
