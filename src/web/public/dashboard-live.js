(() => {
  const mode = document.body.dataset.dashboard;
  if (!mode) return;
  const status = document.getElementById("live-status");
  const labels = {
    plays: "Plays",
    requests: "Requests",
    storageUsed: "Storage",
    skips: "Skips",
    stops: "Stops",
    commands: "Commands",
  };
  let refreshing = false;
  let listLoaded = false;
  let summaryLoaded = false;
  let activityLoaded = false;
  const pendingControls = new Map();
  const pendingSaves = new Set();
  let playerGuilds = [];
  const list = document.getElementById("guild-list");

  async function load(url) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const message =
        response.status === 401
          ? "Your session has expired. Sign in again to refresh."
          : response.status === 403
            ? "You no longer have access to this view."
            : response.status === 400
              ? "Check your filters: use a valid date range, action name, and user ID."
              : "We couldn’t refresh this view. We’ll try again shortly.";
      throw new Error(message);
    }
    return response.json();
  }

  function setStatus(text, state = "success") {
    status.textContent = text;
    status.dataset.state = state;
  }

  function showTableMessage(body, text, columns) {
    body.querySelectorAll("[data-skeleton]").forEach((row) => row.remove());
    body.querySelector("[data-placeholder]")?.remove();
    const row = document.createElement("tr");
    row.dataset.placeholder = "";
    const cell = document.createElement("td");
    cell.colSpan = columns;
    cell.className = "table-empty";
    cell.textContent = text;
    row.append(cell);
    body.append(row);
    return cell;
  }

  function retryButton(parent, retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline-light d-block mt-3";
    button.textContent = "Try again";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await retry();
      } finally {
        button.disabled = false;
      }
    });
    parent.append(button);
  }

  function initialListError() {
    const players = document.getElementById("live-players");
    if (players)
      players.textContent = "Player information is unavailable. Try refreshing server statistics.";
    const total = document.getElementById("guild-total");
    if (total) total.textContent = "—";
    list.querySelectorAll("[data-skeleton], [data-load-error]").forEach((node) => node.remove());
    // Keep the server-rendered nodes for reconciliation, but don't show stale content.
    list.dataset.initial = "loading";
    const col = document.createElement("div");
    col.className = "col-12";
    col.dataset.loadError = "";
    const message = document.createElement("div");
    message.className = "region-error";
    message.textContent = "Server statistics couldn’t be loaded.";
    retryButton(message, refresh);
    col.append(message);
    list.append(col);
  }

  function serverCard(guild, admin) {
    const col = document.createElement("div");
    col.className = "col";
    col.dataset.guildId = guild.id;
    const card = document.createElement("article");
    card.className = "card dashboard-card server-card h-100 p-4";
    const header = document.createElement("div");
    header.className = "server-card-header";
    const identity = document.createElement("div");
    identity.className = "server-card-identity";
    const image = document.createElement("img");
    image.className = "guild-icon";
    image.alt = "";
    image.width = 56;
    image.height = 56;
    const fallback = document.createElement("div");
    fallback.className = "guild-icon guild-placeholder";
    fallback.setAttribute("aria-hidden", "true");
    identity.append(image, fallback);
    header.append(identity);
    const heading = document.createElement(admin ? "a" : "h3");
    heading.className = "h5 fw-semibold text-break mb-0 server-card-title";
    heading.dataset.guildName = "";
    if (admin) heading.href = `/admin/guild/${encodeURIComponent(guild.id)}`;
    header.append(heading);
    card.append(header);
    const grid = document.createElement("div");
    grid.className = "row row-cols-2 row-cols-md-3 g-3 text-center";
    for (const [key, label] of Object.entries(labels)) {
      const item = document.createElement("div");
      item.className = "col";
      const value = document.createElement("p");
      value.className = "h5 fw-semibold mb-0";
      value.dataset.stat = key;
      const title = document.createElement("p");
      title.className = "small text-secondary mb-0";
      title.textContent = label;
      item.append(value, title);
      if (key === "storageUsed") {
        const limit = document.createElement("small");
        limit.className = "text-secondary";
        limit.dataset.storageLimit = "";
        const progress = document.createElement("div");
        progress.className = "progress mt-2";
        progress.dataset.storageProgress = "";
        progress.style.height = "6px";
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", "Guild storage quota");
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        const bar = document.createElement("div");
        bar.className = "progress-bar";
        progress.append(bar);
        item.append(limit, progress);
      }
      grid.append(item);
    }
    card.append(grid);
    if (admin) {
      const recent = document.createElement("p");
      recent.className = "small text-secondary mt-3 mb-0";
      recent.dataset.recent = "";
      card.append(recent);
      const open = document.createElement("a");
      open.href = heading.href;
      open.className = "btn btn-outline-light mt-4 align-self-start";
      open.textContent = "View server analytics →";
      card.append(open);
    }
    const manage = document.createElement("a");
    manage.href = `/dashboard/guilds/${encodeURIComponent(guild.id)}`;
    manage.className = "btn btn-outline-light mt-3 align-self-start";
    manage.textContent = "Queue & settings →";
    card.append(manage);
    const setup = document.createElement("a");
    setup.href = `/onboard/${encodeURIComponent(guild.id)}`;
    setup.className = "btn btn-outline-light mt-2 align-self-start";
    setup.textContent = "Server setup →";
    card.append(setup);
    col.append(card);
    updateCard(col, guild);
    return col;
  }

  function updateCard(col, guild) {
    col.querySelector("[data-guild-name]").textContent = guild.name;
    const image = col.querySelector("img.guild-icon");
    const fallback = col.querySelector(".guild-placeholder");
    if (!image.dataset.errorBound) {
      image.addEventListener("error", () => {
        image.hidden = true;
        fallback.hidden = false;
      });
      image.dataset.errorBound = "true";
      if (image.complete && image.getAttribute("src") && image.naturalWidth === 0) {
        image.hidden = true;
        fallback.hidden = false;
      }
    }
    fallback.textContent = guild.name.charAt(0).toUpperCase() || "♫";
    if (guild.iconUrl) {
      if (image.getAttribute("src") !== guild.iconUrl) {
        image.src = guild.iconUrl;
        image.hidden = false;
        fallback.hidden = true;
      }
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      fallback.hidden = false;
    }
    for (const key of Object.keys(labels))
      col.querySelector(`[data-stat="${key}"]`).textContent = guild[key];
    col.querySelector("[data-storage-limit]").textContent = `of ${guild.storageLimit ?? "100 MB"}`;
    updateStorageProgress(col, guild);
    const recent = col.querySelector("[data-recent]");
    if (recent)
      recent.textContent = `Last 7 days: ${guild.recent.plays} plays · ${guild.recent.adds} library adds · ${guild.recent.commands} commands · ${guild.recent.errors} errors`;
  }

  function updateStorageProgress(container, data) {
    const progress = container.querySelector("[data-storage-progress]");
    if (!progress) return;
    const percentage = Number.isFinite(data.storagePercentage) ? data.storagePercentage : 0;
    const width = Math.max(0, Math.min(100, percentage));
    progress.setAttribute("aria-valuenow", String(width));
    progress.setAttribute(
      "aria-valuetext",
      `${Math.round(percentage)}% of storage quota${data.storageOverQuota ? " (over quota)" : ""}`,
    );
    const bar = progress.querySelector(".progress-bar");
    bar.className = `progress-bar ${percentage > 90 || data.storageOverQuota ? "bg-danger" : "bg-primary"}`;
    bar.style.width = `${width}%`;
  }

  async function refreshList() {
    const data = await load(mode === "admin" ? "/api/admin/guilds" : "/api/dashboard/guilds");
    const existing = new Map([...list.children].map((col) => [col.dataset.guildId, col]));
    const ids = new Set(data.guilds.map((guild) => guild.id));
    for (const col of [...list.children]) if (!ids.has(col.dataset.guildId)) col.remove();
    for (const guild of data.guilds) {
      let col = existing.get(guild.id);
      // Upgrade older server-rendered cards once; subsequent refreshes preserve their DOM.
      if (!col?.querySelector("[data-guild-name]")) {
        const replacement = serverCard(guild, mode === "admin");
        if (col) col.replaceWith(replacement);
        else list.append(replacement);
        col = replacement;
      } else updateCard(col, guild);
    }
    if (!data.guilds.length) {
      const empty = document.createElement("div");
      empty.className = "col-12";
      const message = document.createElement("p");
      message.className = "empty-state mb-0";
      message.textContent =
        mode === "admin"
          ? "No servers yet. Invite Sashimi to a server to see it here."
          : "No servers to show. You’ll see servers you manage once Sashimi has joined them.";
      empty.append(message);
      list.append(empty);
    }
    const total = document.getElementById("guild-total");
    if (total) total.textContent = `${data.guilds.length} total`;
    listLoaded = true;
    delete list.dataset.initial;
    refreshPlayers(data.guilds);
  }

  function refreshPlayers(guilds) {
    playerGuilds = guilds;
    const root = document.getElementById("live-players");
    if (!root) return;
    const content = document.createDocumentFragment();
    for (const guild of guilds) {
      const state = guild.player;
      if (!state) continue;
      const card = document.createElement("article");
      card.className = "border-top pt-3 mt-3";
      card.dataset.playerGuildId = guild.id;
      const header = document.createElement("div");
      header.className = "d-flex align-items-center gap-3";
      if (/^https?:\/\//i.test(state.track.thumbnail || "")) {
        const thumbnail = document.createElement("img");
        thumbnail.src = state.track.thumbnail;
        thumbnail.alt = "";
        thumbnail.width = 64;
        thumbnail.height = 64;
        thumbnail.className = "rounded object-fit-cover";
        thumbnail.addEventListener("error", () => {
          thumbnail.hidden = true;
        });
        header.append(thumbnail);
      }
      const identity = document.createElement("div");
      const name = document.createElement("p");
      name.className = "small text-secondary mb-1";
      name.textContent = `${guild.name} · ${state.status} · Loop: ${state.loopMode}`;
      const title = document.createElement("h3");
      title.className = "h5 mb-1";
      title.textContent = state.track.title;
      const artist = document.createElement("p");
      artist.className = "text-secondary mb-0";
      artist.textContent = state.track.artist;
      identity.append(name, title, artist);
      header.append(identity);
      card.append(header);
      const time = (seconds) => {
        const value = Math.max(0, Math.floor(seconds));
        return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
      };
      const position = document.createElement("p");
      position.className = "small text-secondary mt-2 mb-1";
      position.textContent = `${time(state.progressSeconds)} / ${state.track.durationSeconds ? time(state.track.durationSeconds) : "Live"}`;
      const progress = document.createElement("div");
      progress.className = "progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", "Playback progress");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      const percent = Math.max(0, Math.min(100, state.progressPercent));
      progress.setAttribute("aria-valuenow", String(percent));
      const bar = document.createElement("div");
      bar.className = "progress-bar bg-primary";
      bar.style.width = `${percent}%`;
      progress.append(bar);
      card.append(position, progress);
      const controls = document.createElement("div");
      controls.className = "d-flex gap-2 mt-3";
      const pendingToggle = pendingControls.get(guild.id);
      const toggleAction =
        pendingToggle === "pause" || pendingToggle === "resume"
          ? pendingToggle
          : state.status === "paused"
            ? "resume"
            : "pause";
      for (const [action, label, icon] of [
        toggleAction === "resume"
          ? ["resume", "Resume", "play-fill"]
          : ["pause", "Pause", "pause-fill"],
        ["skip", "Skip", "skip-forward-fill"],
        ["stop", "Stop", "stop-fill"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn btn-sm ${action === "stop" ? "btn-outline-danger" : "btn-outline-light"}`;
        button.dataset.playerAction = action;
        button.setAttribute("aria-label", `${label} playback in ${guild.name}`);
        button.disabled =
          pendingControls.has(guild.id) || (state.status === "loading" && action !== "stop");
        const symbol = document.createElement("i");
        symbol.className = `bi bi-${icon} me-1`;
        symbol.setAttribute("aria-hidden", "true");
        button.append(symbol, document.createTextNode(label));
        if (pendingControls.get(guild.id) === action) {
          const spinner = document.createElement("span");
          spinner.className = "spinner-border spinner-border-sm ms-2";
          spinner.setAttribute("aria-hidden", "true");
          button.setAttribute("aria-busy", "true");
          button.append(spinner);
        }
        button.addEventListener("click", () => void controlPlayer(guild.id, action, guild.name));
        controls.append(button);
      }
      card.append(controls);
      const save = document.createElement("button");
      save.type = "button";
      save.dataset.saveQueue = "";
      save.className = "btn btn-sm btn-outline-light mt-2";
      save.textContent = pendingSaves.has(guild.id)
        ? "Saving queue…"
        : "Save Current Queue to Playlist";
      save.disabled = pendingSaves.has(guild.id);
      save.addEventListener("click", () => void saveQueuePlaylist(guild.id));
      card.append(save);
      if (state.nextTracks.length) {
        const label = document.createElement("p");
        label.className = "small text-secondary mt-3 mb-1";
        label.textContent = "Up next";
        const upcoming = document.createElement("ol");
        upcoming.className = "small mb-0";
        for (const track of state.nextTracks.slice(0, 5)) {
          const item = document.createElement("li");
          item.textContent = track.title;
          upcoming.append(item);
        }
        card.append(label, upcoming);
      }
      content.append(card);
    }
    if (!content.childNodes.length) {
      const empty = document.createElement("p");
      empty.className = "text-secondary mb-0";
      empty.textContent = "Nothing is playing in your servers.";
      content.append(empty);
    }
    root.replaceChildren(content);
  }

  async function controlPlayer(guildId, action, guildName) {
    if (pendingControls.has(guildId)) return;
    const feedback = document.getElementById("player-control-status");
    pendingControls.set(guildId, action);
    refreshPlayers(playerGuilds);
    feedback.textContent = `Applying ${action} in ${guildName}…`;
    try {
      const response = await fetch(`/api/dashboard/guilds/${encodeURIComponent(guildId)}/control`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sashimi-Request": "control" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Sign in again to control playback."
            : response.status === 403
              ? "You no longer have permission to control this server."
              : response.status === 409
                ? "The player is busy or no longer active. Please try again."
                : "The player action could not be applied. Check the current player before retrying.",
        );
      }
      feedback.textContent = `Applied ${action} in ${guildName}.`;
      try {
        await refreshList();
      } catch {
        feedback.textContent += " Status refresh failed; it will refresh on the next poll.";
      }
    } catch (error) {
      feedback.textContent =
        error instanceof TypeError
          ? "Connection interrupted. The action may have completed; refresh before retrying."
          : error.message;
    } finally {
      pendingControls.delete(guildId);
      refreshPlayers(playerGuilds);
    }
  }

  async function saveQueuePlaylist(guildId) {
    if (pendingSaves.has(guildId)) return;
    const name = window.prompt("Name for your new playlist:");
    if (!name?.trim()) return;
    const feedback = document.getElementById("player-control-status");
    pendingSaves.add(guildId);
    refreshPlayers(playerGuilds);
    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Sashimi-Request": "playlists" },
        body: JSON.stringify({ name: name.trim(), guildId }),
      });
      if (!response.ok)
        throw new Error(
          "Could not save the queue. Check permissions, playlist name, and queue availability.",
        );
      feedback.textContent =
        "Queue saved. Open Playlists to view it or use /load custom name: in Discord.";
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      pendingSaves.delete(guildId);
      refreshPlayers(playerGuilds);
    }
  }

  async function refreshInfrastructure() {
    const panel = document.getElementById("infrastructure-health");
    if (!panel) return;
    let data;
    try {
      data = await load("/api/admin/infrastructure");
    } catch {
      panel.querySelector("[data-infra-uptime]").textContent = "Unavailable";
      panel.querySelector("[data-infra-load]").textContent = "Unavailable";
      panel.querySelector("[data-infra-cores]").textContent = "—";
      panel.querySelector("[data-infra-source]").textContent = "Unavailable";
    }
    if (data) {
      panel.querySelector("[data-infra-uptime]").textContent = data.uptime;
      panel.querySelector("[data-infra-load]").textContent = data.loadAverage;
      panel.querySelector("[data-infra-cores]").textContent = data.coreCount;
      panel.querySelector("[data-infra-source]").textContent = data.volumeSource;
    }
    for (const key of ["memory", "cpu", "volume"]) {
      const metric = data?.[key];
      const value = panel.querySelector(`[data-infra-value="${key}"]`);
      value.textContent = metric?.text ?? "Unavailable";
      value.classList.toggle("text-secondary", metric?.percentage == null);
      const meter = panel.querySelector(`[data-infra-meter="${key}"]`);
      meter.hidden = metric?.percentage == null;
      const percent = metric?.percentage ?? 0;
      const width = Math.max(0, Math.min(100, percent));
      const progress = meter.querySelector(".progress");
      progress.setAttribute("aria-valuenow", String(width));
      progress.setAttribute("aria-valuetext", `${Math.round(percent)}%`);
      const bar = meter.querySelector(".progress-bar");
      bar.className = `progress-bar ${percent > 90 ? "bg-danger" : "bg-primary"}`;
      bar.style.width = `${width}%`;
    }
  }

  const guildId = document.body.dataset.guildId;
  const base = `/api/admin/guilds/${encodeURIComponent(guildId || "")}`;
  const form = document.getElementById("activity-filters");
  const rows = document.getElementById("activity-rows");
  const older = document.getElementById("load-older");
  let filters = new URLSearchParams();
  let latestId = 0;
  let oldestId = 0;
  let requestGeneration = 0;
  let activityBusy = false;
  let rollingRange = true;
  const seen = new Set();

  function eventRow(event) {
    const row = document.createElement("tr");
    row.dataset.eventId = event.id;
    for (const [index, value] of [
      event.time,
      event.username || event.user,
      event.eventType,
      event.action,
      event.details,
    ].entries()) {
      const cell = document.createElement("td");
      if (index === 2 || (index === 3 && event.action === "download")) {
        const badge = document.createElement("span");
        badge.className = "event-badge";
        badge.dataset.kind = index === 2 ? event.eventType : "download";
        badge.textContent = value;
        cell.append(badge);
      } else cell.textContent = value;
      if (index === 1 && event.userId) {
        const subtitle = document.createElement("small");
        subtitle.className = "text-secondary d-block";
        subtitle.textContent = event.userId;
        cell.append(subtitle);
      }
      if (index === 4 && event.trackName) {
        const title = document.createElement("strong");
        title.className = "d-block mb-1";
        title.textContent = event.trackName;
        cell.prepend(title);
      }
      row.append(cell);
    }
    return row;
  }

  function appendEvents(events, isLive) {
    rows.querySelectorAll("[data-skeleton]").forEach((row) => row.remove());
    rows.querySelector("[data-placeholder]")?.remove();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (isLive) rows.prepend(eventRow(event));
      else rows.append(eventRow(event));
    }
    // Polling should not grow the document indefinitely.
    while (rows.children.length > 500) {
      seen.delete(Number(rows.lastElementChild.dataset.eventId));
      rows.lastElementChild.remove();
    }
    if (rows.lastElementChild) oldestId = Number(rows.lastElementChild.dataset.eventId);
    if (rows.firstElementChild) latestId = Number(rows.firstElementChild.dataset.eventId);
    if (!rows.children.length) showTableMessage(rows, "No activity matches these filters.", 5);
  }

  function activityUrl(extra = {}) {
    const params = new URLSearchParams(filters);
    if (rollingRange) params.set("to", String(Date.now() + 1));
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return `${base}/events?${params}`;
  }

  async function loadActivity(kind) {
    if (activityBusy) return;
    activityBusy = true;
    older.disabled = true;
    rows.setAttribute("aria-busy", "true");
    const generation = requestGeneration;
    try {
      const extra =
        kind === "older"
          ? { before: oldestId }
          : kind === "live" && latestId
            ? { since: latestId }
            : {};
      const data = await load(activityUrl(extra));
      if (generation !== requestGeneration) return;
      appendEvents(data.events, kind === "live");
      activityLoaded = true;
      if (kind !== "live") older.hidden = !data.hasMore;
      setStatus("Activity is up to date.");
      return true;
    } catch (error) {
      setStatus(
        error instanceof TypeError
          ? "Connection interrupted. We’ll try again shortly."
          : error.message,
        "error",
      );
      if (!seen.size) {
        const cell = showTableMessage(
          rows,
          "Activity couldn’t be loaded. Check the message above.",
          5,
        );
        retryButton(cell, () => loadActivity("initial"));
      }
      return false;
    } finally {
      activityBusy = false;
      older.disabled = false;
      rows.setAttribute("aria-busy", "false");
      if (generation !== requestGeneration) void loadActivity("initial");
    }
  }

  function applyFilters(event) {
    if (event) event.preventDefault();
    const values = new FormData(form);
    const now = Date.now();
    const range = values.get("range");
    rollingRange = range !== "custom";
    let from = now - Number(range) * 86_400_000;
    let to = now + 1;
    if (range === "custom") {
      const start = values.get("from");
      const end = values.get("to");
      if (!start || !end) {
        setStatus("Choose both dates for a custom range.", "warning");
        return;
      }
      from = Date.parse(`${start}T00:00:00Z`);
      to = Date.parse(`${end}T00:00:00Z`) + 86_400_000;
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to <= from ||
        to - from > 90 * 86_400_000
      ) {
        setStatus("Choose a valid range of at most 90 days.", "warning");
        return;
      }
    }
    filters = new URLSearchParams({ from: String(from), to: String(to) });
    for (const [field, key] of [
      ["type", "type"],
      ["action", "action"],
      ["user", "user"],
    ]) {
      const value = String(values.get(field) || "").trim();
      if (value) filters.set(key, value);
    }
    requestGeneration++;
    seen.clear();
    // On first entry, retain the server-rendered skeleton until the request settles.
    // Filter changes after a successful load use plain loading copy, not skeletons.
    if (activityLoaded || !rows.querySelector("[data-skeleton]")) {
      rows.replaceChildren();
      showTableMessage(rows, "Loading activity…", 5);
    }
    latestId = 0;
    oldestId = 0;
    older.hidden = true;
    void loadActivity("initial");
  }

  async function refreshDetailSummary() {
    const body = document.getElementById("range-stats");
    body.setAttribute("aria-busy", "true");
    try {
      const data = await load(`${base}/summary`);
      body.replaceChildren();
      for (const [key, label] of [
        ["day", "24 hours"],
        ["week", "7 days"],
        ["month", "30 days"],
      ]) {
        const row = document.createElement("tr");
        for (const value of [
          label,
          ...["plays", "requests", "adds", "skips", "stops", "commands", "errors"].map(
            (name) => data.ranges[key][name],
          ),
        ]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        body.append(row);
      }
      const totals = data.allTime;
      document.getElementById("all-time").textContent =
        `Since tracking began: ${totals.plays} plays · ${totals.requests} requests · ${totals.skips} skips · ${totals.stops} stops · ${totals.commands_used} commands.`;
      document.getElementById("storage").textContent =
        `Audio storage: ${data.storageUsed} / ${data.storageLimit ?? "100 MB"} (${Math.round(data.storagePercentage ?? 0)}%). Shared audio files aren’t included.`;
      document.getElementById("storage-meter").hidden = false;
      updateStorageProgress(document.getElementById("storage-meter"), data);
      const quotaInput = document.getElementById("max-storage-mb");
      if (quotaInput && !quotaInput.dataset.loaded) {
        quotaInput.value = String(data.maxStorageBytes / 1048576);
        quotaInput.disabled = false;
        quotaInput.dataset.loaded = "true";
        document.querySelector("#quota-settings button").disabled = false;
      }
      summaryLoaded = true;
      setStatus("Statistics are up to date.");
      return true;
    } catch (error) {
      setStatus(
        error instanceof TypeError
          ? "Connection interrupted. We’ll try again shortly."
          : error.message,
        "error",
      );
      if (!summaryLoaded) {
        const cell = showTableMessage(body, "Statistics couldn’t be loaded.", 8);
        retryButton(cell, refreshDetailSummary);
        document.getElementById("all-time").textContent = "";
        document.getElementById("storage").textContent = "";
      }
      return false;
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }

  async function refresh() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    document.getElementById("guild-list")?.setAttribute("aria-busy", "true");
    status.setAttribute("aria-busy", "true");
    try {
      if (mode === "detail") {
        const [summaryOkay, activityOkay] = await Promise.all([
          refreshDetailSummary(),
          activityBusy ? Promise.resolve(true) : loadActivity(latestId ? "live" : "initial"),
        ]);
        if (summaryOkay === false || activityOkay === false) {
          setStatus(
            "Some data couldn’t be refreshed. Your last loaded data is still shown; use Try again for any region that hasn’t loaded.",
            "error",
          );
          return;
        }
      } else {
        await Promise.all([
          refreshList(),
          mode === "admin" ? refreshInfrastructure() : Promise.resolve(),
        ]);
      }
      setStatus("Statistics are up to date.");
    } catch (error) {
      setStatus(
        error instanceof TypeError
          ? "Connection interrupted. We’ll try again shortly."
          : error.message,
        "error",
      );
      if (list && !listLoaded) initialListError();
    } finally {
      refreshing = false;
      status.setAttribute("aria-busy", "false");
      document.getElementById("guild-list")?.setAttribute("aria-busy", "false");
    }
  }

  if (mode === "detail") {
    form.addEventListener("submit", applyFilters);
    older.addEventListener("click", () => void loadActivity("older"));
    applyFilters();
    document.getElementById("quota-settings")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("max-storage-mb");
      const button = event.currentTarget.querySelector("button");
      const feedback = document.getElementById("quota-status");
      button.disabled = true;
      feedback.textContent = "Saving quota…";
      try {
        const response = await fetch(`${base}/settings`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Sashimi-Request": "quota" },
          body: JSON.stringify({ max_storage_mb: Number(input.value) }),
        });
        if (!response.ok)
          throw new Error("Quota could not be saved. Check the value and your owner session.");
        await refreshDetailSummary();
        feedback.textContent = "Quota saved. Existing files have not been deleted.";
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
  void refresh();
  if (window.sashimiLive) window.sashimiLive(refresh);
  else setInterval(() => void refresh(), 15_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
})();
