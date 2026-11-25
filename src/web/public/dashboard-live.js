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
    const recent = col.querySelector("[data-recent]");
    if (recent)
      recent.textContent = `Last 7 days: ${guild.recent.plays} plays · ${guild.recent.adds} library adds · ${guild.recent.commands} commands · ${guild.recent.errors} errors`;
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
        `Audio storage: ${data.storageUsed}. Shared audio files aren’t included.`;
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
        await refreshList();
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
  }
  void refresh();
  setInterval(() => void refresh(), 15_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });
})();
