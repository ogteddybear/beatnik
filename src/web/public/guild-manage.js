(() => {
  const base = `/api/dashboard/guilds/${encodeURIComponent(document.body.dataset.guildId)}`;
  const list = document.getElementById("full-queue");
  const status = document.getElementById("queue-status");
  let snapshot = null;
  let busy = false;
  let dragging = false;
  let polling = false;
  let version = 0;
  async function request(path, options = {}) {
    const response = await fetch(base + path, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Sashimi-Request": "guild",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(
        body?.error || `Request failed (${response.status}). Check your permissions and refresh.`,
      );
    }
    return response.json();
  }
  function button(label, text, action, disabled) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "btn btn-sm btn-outline-secondary";
    element.textContent = text;
    element.setAttribute("aria-label", label);
    element.disabled = disabled;
    element.addEventListener("click", action);
    return element;
  }
  function render() {
    list.replaceChildren();
    for (const track of snapshot.tracks) {
      const row = document.createElement("li");
      row.className = "list-group-item d-flex flex-wrap align-items-center gap-2";
      const handle = document.createElement("span");
      handle.className = "queue-drag-handle";
      handle.textContent = "⠿";
      handle.title = "Drag to reorder";
      handle.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "flex-grow-1 text-break";
      title.textContent = `${track.position}. ${track.title} — ${track.artist}${track.current ? " · Current" : track.played ? " · Played" : ""}`;
      const disabled = busy || snapshot.loading;
      row.append(
        handle,
        title,
        button(
          `Move ${track.title} up`,
          "↑",
          () => mutate("/queue/reorder", { from: track.position, to: track.position - 1 }),
          disabled || track.position === 1,
        ),
        button(
          `Move ${track.title} down`,
          "↓",
          () => mutate("/queue/reorder", { from: track.position, to: track.position + 1 }),
          disabled || track.position === snapshot.tracks.length,
        ),
        button(
          `Remove ${track.title}`,
          "🗑",
          () => mutate(`/queue/${track.position}`, null, "DELETE"),
          disabled,
        ),
      );
      list.append(row);
    }
  }
  async function refresh() {
    if (busy || dragging || polling || document.hidden) return;
    polling = true;
    const started = version;
    try {
      const data = await request("/queue");
      if (busy || dragging || started !== version) return;
      snapshot = data;
      render();
      status.textContent = snapshot.tracks.length ? "Queue is up to date." : "The queue is empty.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      polling = false;
    }
  }
  async function mutate(path, body, method = "POST") {
    if (busy || !snapshot) return;
    version++;
    busy = true;
    render();
    try {
      snapshot = await request(path, {
        method,
        headers: { "X-Queue-Revision": snapshot.revision },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      status.textContent = "Queue updated.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      render();
    }
  }
  if (window.Sortable) {
    window.Sortable.create(list, {
      handle: ".queue-drag-handle",
      animation: 150,
      onMove: () => !busy && !snapshot?.loading,
      onStart: () => {
        dragging = true;
      },
      onEnd: (event) => {
        dragging = false;
        if (!busy && snapshot && !snapshot.loading && event.oldIndex !== event.newIndex)
          void mutate("/queue/reorder", { from: event.oldIndex + 1, to: event.newIndex + 1 });
        else if (snapshot) render();
      },
    });
  }
  const settingsStatus = document.getElementById("settings-status");
  const fields = document.getElementById("settings-fields");
  async function loadSettings() {
    try {
      const settings = await request("/settings");
      document.getElementById("volume").value = settings.volume;
      document.getElementById("autoplay").checked = settings.autoplay_enabled;
      document.getElementById("dj-role").value = settings.dj_role_id || "";
      fields.disabled = false;
      settingsStatus.textContent = "";
    } catch (error) {
      settingsStatus.textContent = error.message;
    }
  }
  document.getElementById("guild-settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    fields.disabled = true;
    try {
      await request("/settings", {
        method: "POST",
        body: JSON.stringify({
          volume: Number(document.getElementById("volume").value),
          autoplay_enabled: document.getElementById("autoplay").checked,
          dj_role_id: document.getElementById("dj-role").value.trim() || null,
        }),
      });
      settingsStatus.textContent = "Settings saved.";
    } catch (error) {
      settingsStatus.textContent = error.message;
    } finally {
      fields.disabled = false;
    }
  });
  document.getElementById("refresh-queue").addEventListener("click", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
  void loadSettings();
  void refresh();
  if (window.sashimiLive) window.sashimiLive(refresh);
  else setInterval(() => void refresh(), 15000);
})();
