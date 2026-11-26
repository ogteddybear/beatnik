(() => {
  const base = `/api/playlists/${encodeURIComponent(document.body.dataset.playlistId)}`;
  const status = document.getElementById("editor-status");
  const list = document.getElementById("editor-tracks");
  let playlist;
  let busy = false;
  async function request(url, method = "GET", body) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sashimi-Request": "playlists" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(
        error?.error || `Request failed (${response.status}). Refresh and try again.`,
      );
    }
    return response.json();
  }
  function button(text, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "btn btn-sm btn-outline-light";
    element.textContent = text;
    element.disabled = busy;
    element.addEventListener("click", action);
    return element;
  }
  async function action(work) {
    if (busy) return;
    busy = true;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      await work();
      status.textContent = "Playlist updated.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      render();
      document.querySelectorAll("button").forEach((button) => {
        button.disabled = false;
      });
    }
  }
  function render() {
    list.replaceChildren();
    for (const [index, track] of (playlist?.tracks || []).entries()) {
      const row = document.createElement("li");
      row.className = "list-group-item d-flex gap-2 flex-wrap align-items-center";
      const handle = document.createElement("span");
      handle.className = "playlist-handle";
      handle.textContent = "⠿";
      const title = document.createElement("span");
      title.className = "flex-grow-1 text-break";
      title.textContent = `${index + 1}. ${track.title}`;
      row.append(
        handle,
        title,
        button("↑", () => move(index, index - 1)),
        button("↓", () => move(index, index + 1)),
        button("Remove", () =>
          action(async () => {
            playlist = (await request(`${base}/tracks/${track.playlistTrackId}`, "DELETE"))
              .playlist;
          }),
        ),
      );
      list.append(row);
    }
  }
  function move(from, to) {
    if (!playlist || to < 0 || to >= playlist.tracks.length) return;
    void action(async () => {
      const ids = playlist.tracks.map((track) => track.playlistTrackId);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      playlist = (await request(`${base}/reorder`, "POST", { trackIds: ids })).playlist;
    });
  }
  if (window.Sortable)
    window.Sortable.create(list, {
      handle: ".playlist-handle",
      onMove: () => !busy,
      onEnd: (event) => {
        if (!busy && event.oldIndex !== event.newIndex) move(event.oldIndex, event.newIndex);
        else render();
      },
    });
  document.getElementById("rename-playlist").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
      playlist = (
        await request(base, "PUT", { name: document.getElementById("playlist-name").value })
      ).playlist;
    });
  });
  document.getElementById("search-tracks").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
      const data = await request(
        `/api/search/youtube?q=${encodeURIComponent(document.getElementById("search-query").value)}`,
      );
      const results = document.getElementById("search-results");
      results.replaceChildren();
      for (const track of data.tracks) {
        const title = document.createElement("p");
        title.textContent = `${track.title} — ${track.channelName}`;
        const add = button("Add track", () =>
          action(async () => {
            playlist = (await request(`${base}/tracks`, "POST", { url: track.url })).playlist;
          }),
        );
        results.append(title, add);
      }
      if (!data.tracks.length) results.textContent = "No tracks found.";
    });
  });
  document.getElementById("spotify-import").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
      playlist = (
        await request(`${base}/import/spotify`, "POST", {
          playlist: document.getElementById("spotify-playlist").value.trim(),
        })
      ).playlist;
    });
  });
  async function load() {
    await action(async () => {
      playlist = (await request(base)).playlist;
      document.getElementById("playlist-name").value = playlist.name;
    });
  }
  document.getElementById("editor-refresh").addEventListener("click", () => void load());
  void load();
})();
