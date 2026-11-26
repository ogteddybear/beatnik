(() => {
  const root = document.getElementById("playlists");
  const status = document.getElementById("playlist-status");
  async function request(url, method = "GET", body) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Sashimi-Request": "playlists" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Sign in again to manage playlists."
          : "Could not update playlists. Check the name or track URL and try again.",
      );
    return response.status === 204 ? null : response.json();
  }
  async function refresh() {
    const data = await request("/api/playlists");
    root.replaceChildren();
    for (const playlist of data.playlists) {
      const col = document.createElement("section");
      col.className = "col-12 col-lg-6";
      const card = document.createElement("div");
      card.className = "card dashboard-card p-4 h-100";
      const title = document.createElement("h2");
      title.className = "h4";
      title.textContent = playlist.name;
      const list = document.createElement("ol");
      for (const track of playlist.tracks) {
        const item = document.createElement("li");
        item.textContent = `${track.title} · ${Math.floor(track.length / 60)}:${String(Math.floor(track.length % 60)).padStart(2, "0")}`;
        list.append(item);
      }
      if (!playlist.tracks.length) {
        const empty = document.createElement("p");
        empty.className = "text-secondary";
        empty.textContent = "No tracks yet.";
        card.append(empty);
      }
      const form = document.createElement("form");
      form.className = "d-flex gap-2 mt-3";
      const input = document.createElement("input");
      input.type = "url";
      input.required = true;
      input.className = "form-control";
      input.placeholder = "Track URL";
      input.setAttribute("aria-label", `Track URL for ${playlist.name}`);
      const add = document.createElement("button");
      add.type = "submit";
      add.className = "btn btn-primary";
      add.textContent = "Add track";
      form.append(input, add);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void mutate(add, `/api/playlists/${playlist.id}/tracks`, "POST", { url: input.value });
      });
      const remove = document.createElement("button");
      remove.className = "btn btn-outline-danger mt-3 align-self-start";
      remove.type = "button";
      remove.textContent = "Delete playlist";
      remove.addEventListener(
        "click",
        () => void mutate(remove, `/api/playlists/${playlist.id}`, "DELETE"),
      );
      card.prepend(title);
      card.append(list, form, remove);
      col.append(card);
      root.append(col);
    }
    status.textContent = data.playlists.length
      ? "Playlists are up to date."
      : "No playlists yet. Create your first playlist above.";
  }
  async function mutate(button, url, method, body) {
    button.disabled = true;
    status.textContent = "Saving…";
    try {
      await request(url, method, body);
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  document.getElementById("create-playlist").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.getElementById("playlist-name");
    void mutate(event.currentTarget.querySelector("button"), "/api/playlists", "POST", {
      name: name.value,
    });
  });
  void refresh().catch((error) => {
    status.textContent = error.message;
  });
})();
