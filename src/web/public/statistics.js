(() => {
  const root = document.getElementById("statistics");
  if (!root) return;
  const status = document.getElementById("statistics-status");
  const refresh = document.getElementById("refresh-statistics");
  let charts = [];
  let busy = false;
  let lastData;
  let breakdown = { labels: [], counts: [] };
  const sourceSelect = document.getElementById("statistics-source");
  function palette() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text-secondary").trim(),
      grid: style.getPropertyValue("--border-color").trim(),
      primary: style.getPropertyValue("--brand-primary").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      success: style.getPropertyValue("--success").trim(),
      warning: style.getPropertyValue("--warning").trim(),
      error: style.getPropertyValue("--error").trim(),
      foreground: style.getPropertyValue("--text-primary").trim(),
      surface: style.getPropertyValue("--surface-section").trim(),
      raised: style.getPropertyValue("--surface-raised").trim(),
      font: style.getPropertyValue("--font-body").trim(),
    };
  }
  function translucent(color, opacity) {
    if (/^#[\da-f]{6}$/i.test(color)) {
      const channels = color
        .slice(1)
        .match(/../g)
        .map((hex) => parseInt(hex, 16));
      return `rgba(${channels.join(", ")}, ${opacity})`;
    }
    return `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`;
  }
  function seriesColors(colors) {
    return [colors.primary, colors.success, colors.warning, colors.accent, colors.error];
  }
  function gradientFill(token) {
    const color = palette()[token];
    let gradient, previousTop, previousBottom;
    return ({ chart: instance }) => {
      if (!instance.chartArea) return translucent(color, 0.08);
      const { top, bottom } = instance.chartArea;
      if (!gradient || top !== previousTop || bottom !== previousBottom) {
        gradient = instance.ctx.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0, translucent(color, 0.22));
        gradient.addColorStop(1, translucent(color, 0.01));
        previousTop = top;
        previousBottom = bottom;
      }
      return gradient;
    };
  }
  function renderLegend() {
    const legend = document.getElementById("distribution-legend");
    if (!legend) return;
    const colors = seriesColors(palette());
    const total = breakdown.counts.reduce((sum, value) => sum + value, 0);
    legend.replaceChildren();
    breakdown.labels.forEach((label, index) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "statistics-legend-label";
      const swatch = document.createElement("span");
      swatch.className = "statistics-legend-swatch";
      swatch.style.backgroundColor = colors[index % colors.length];
      swatch.setAttribute("aria-hidden", "true");
      name.append(swatch, document.createTextNode(label));
      const value = document.createElement("span");
      value.className = "tabular-nums text-body-secondary text-nowrap";
      const count = breakdown.counts[index];
      value.textContent = `${count.toLocaleString()} · ${total ? ((count / total) * 100).toFixed(1) : "0"}%`;
      item.append(name, value);
      legend.append(item);
    });
  }
  function rankedList(id, entries) {
    const list = document.getElementById(id);
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const row = document.createElement("li");
      row.className = "list-group-item d-flex justify-content-between align-items-center gap-2";
      const identity = document.createElement("div");
      identity.className = "statistics-ranked-identity d-flex align-items-center gap-3";
      const rank = document.createElement("span");
      rank.className = "badge statistics-rank tabular-nums";
      rank.textContent = index + 1;
      const title = document.createElement("div");
      title.className = "statistics-ranked-title";
      const name = document.createElement("span");
      name.className = "text-body";
      name.textContent = entry.title;
      title.append(name);
      if (entry.subtitle) {
        const subtitle = document.createElement("small");
        subtitle.className = "d-block text-body-secondary mt-1";
        subtitle.textContent = entry.subtitle;
        title.append(subtitle);
      }
      identity.append(rank, title);
      const count = document.createElement("span");
      count.className = "badge statistics-count tabular-nums text-nowrap";
      count.textContent = entry.count.toLocaleString();
      count.setAttribute("aria-label", `${entry.count} ${entry.unit}`);
      row.append(identity, count);
      list.append(row);
    });
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "list-group-item small text-body-secondary py-3";
      empty.textContent = "No activity recorded in this period.";
      list.append(empty);
    }
  }
  function summaryMetrics(labels, counts) {
    const summary = document.getElementById("distribution-data");
    summary.replaceChildren();
    labels.forEach((label, index) => {
      const column = document.createElement("div");
      column.className = "col";
      const box = document.createElement("div");
      box.className = "statistics-summary-metric h-100";
      const title = document.createElement("p");
      title.className = "small text-body-secondary text-uppercase fw-semibold mb-1";
      title.textContent = label;
      const value = document.createElement("p");
      value.className = "fs-4 fw-semibold tabular-nums mb-0";
      value.textContent = counts[index].toLocaleString();
      box.append(title, value);
      column.append(box);
      summary.append(column);
    });
  }
  function externalTooltip({ chart: instance, tooltip }) {
    const parent = instance.canvas.parentElement;
    let element = parent.querySelector(".statistics-tooltip");
    if (!element) {
      element = document.createElement("div");
      element.className = "statistics-tooltip tabular-nums";
      element.id = `${instance.canvas.id}-tooltip`;
      element.setAttribute("role", "tooltip");
      instance.canvas.setAttribute("aria-describedby", element.id);
      parent.append(element);
    }
    element.hidden = !tooltip.opacity;
    if (element.hidden) return;
    element.replaceChildren();
    for (const title of tooltip.title || []) {
      const heading = document.createElement("strong");
      heading.className = "d-block fw-semibold mb-1";
      heading.textContent = title;
      element.append(heading);
    }
    for (const body of tooltip.body || []) {
      for (const line of body.lines) {
        const value = document.createElement("div");
        value.textContent = line;
        element.append(value);
      }
    }
    element.style.left = `${Math.max(8, Math.min(tooltip.caretX + 12, parent.clientWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(tooltip.caretY + 12, parent.clientHeight - element.offsetHeight - 8))}px`;
  }
  function chart(id, type, labels, datasets, extra = {}) {
    const colors = palette();
    return new window.Chart(document.getElementById(id), {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
          ? false
          : { duration: 180 },
        indexAxis: type === "bar" ? "y" : "x",
        font: { family: colors.font },
        ...(type === "doughnut" ? { cutout: "68%" } : {}),
        plugins: {
          legend: {
            display: type === "line" && datasets.length > 1,
            position: "bottom",
            labels: { color: colors.text, usePointStyle: true, boxWidth: 8, padding: 16 },
          },
          tooltip: {
            enabled: false,
            external: externalTooltip,
            backgroundColor: colors.raised,
            titleColor: colors.foreground,
            bodyColor: colors.foreground,
            borderColor: colors.grid,
            borderWidth: 1,
            callbacks: {
              label(context) {
                const value = Number(context.raw) || 0;
                if (type !== "doughnut")
                  return `${context.dataset.label}: ${value.toLocaleString()}`;
                const total = context.dataset.data.reduce((sum, count) => sum + count, 0);
                return `${context.label}: ${value.toLocaleString()} (${total ? ((value / total) * 100).toFixed(1) : "0"}%)`;
              },
            },
          },
        },
        ...(type !== "doughnut"
          ? {
              scales: {
                x: {
                  beginAtZero: type === "bar",
                  ticks: {
                    color: colors.text,
                    precision: 0,
                    maxTicksLimit: 6,
                    maxRotation: 0,
                    ...(type === "line"
                      ? {
                          callback: function (value) {
                            return this.getLabelForValue(value).slice(5);
                          },
                        }
                      : {}),
                  },
                  border: { display: false, dash: [3, 5] },
                  grid: {
                    color: translucent(colors.grid, 0.35),
                    drawTicks: false,
                    display: type === "bar",
                  },
                },
                y: {
                  beginAtZero: true,
                  ticks: {
                    precision: 0,
                    color: colors.text,
                    ...(type === "bar"
                      ? {
                          callback: function (value) {
                            const label = this.getLabelForValue(value);
                            const station = this.chart?.data.datasets[0].stations?.[value];
                            const title = station ? label.slice(0, -(station.length + 4)) : label;
                            const short = title.length > 18 ? title.slice(0, 17) + "…" : title;
                            return station ? [short, station] : short;
                          },
                        }
                      : {}),
                  },
                  border: { display: false, dash: [3, 5] },
                  grid: { color: translucent(colors.grid, 0.35), drawTicks: false },
                },
              },
            }
          : {}),
        ...extra,
      },
    });
  }
  function render(data) {
    const source = sourceSelect?.value || "queue";
    const colors = palette();
    const radio = data.radio || {
      days: data.days.map((day) => ({
        day: day.day,
        songsObserved: 0,
        sessions: 0,
        connectedSeconds: 0,
        errors: 0,
        reconnects: 0,
      })),
      stations: [],
      topTracks: [],
      topArtists: [],
      totals: { songsObserved: 0, sessions: 0, connectedSeconds: 0, errors: 0, reconnects: 0 },
    };
    const radioByDay = new Map(radio.days.map((day) => [day.day, day]));
    const queueErrors = data.days.reduce((sum, day) => sum + (day.errors || 0), 0);
    const metrics =
      source === "radio"
        ? [
            ["Songs tracked", radio.totals.songsObserved],
            ["Sessions", radio.totals.sessions],
            ["Connected minutes", Math.round(radio.totals.connectedSeconds / 60)],
            ["Errors", radio.totals.errors],
          ]
        : source === "all"
          ? [
              ["Queued plays", data.distribution.plays],
              ["Radio songs", radio.totals.songsObserved],
              ["Radio sessions", radio.totals.sessions],
              ["Errors", queueErrors + radio.totals.errors],
            ]
          : [
              ["Plays", data.distribution.plays],
              ["Commands", data.distribution.commands],
              ["Skips", data.distribution.skips],
              ["Errors", queueErrors],
            ];
    metrics.forEach(([label, value], index) => {
      const heading = root.querySelector(`[data-statistic-label="${index}"]`);
      const metric = root.querySelector(`[data-statistic-value="${index}"]`);
      if (heading) heading.textContent = label;
      if (metric) {
        metric.classList.remove("placeholder-glow");
        metric.textContent = Number(value || 0).toLocaleString();
      }
    });
    const columns =
      source === "radio"
        ? ["Day", "Songs observed", "Sessions", "Connected minutes", "Errors", "Reconnects"]
        : source === "all"
          ? ["Day", "Queued plays", "Radio songs observed", "Queue errors", "Radio errors"]
          : ["Day", "Plays", "Skips", "Errors", "Commands"];
    const header = document.getElementById("statistics-columns");
    header.replaceChildren();
    for (const [index, label] of columns.entries()) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.className = index === 0 ? "text-nowrap" : "text-end";
      cell.textContent = label;
      header.append(cell);
    }
    const rows = document.getElementById("statistics-data");
    document.getElementById("statistics-table-caption").textContent =
      source === "queue"
        ? "Daily plays, skips, errors and commands (UTC)"
        : source === "radio"
          ? "Daily radio observations, session starts and connected time (UTC)"
          : "Daily queue starts and radio observations, shown separately (UTC)";
    rows.replaceChildren();
    for (const day of data.days) {
      const live = radioByDay.get(day.day);
      const values =
        source === "radio"
          ? [
              day.day,
              live?.songsObserved || 0,
              live?.sessions || 0,
              ((live?.connectedSeconds || 0) / 60).toFixed(1),
              live?.errors || 0,
              live?.reconnects || 0,
            ]
          : source === "all"
            ? [day.day, day.plays, live?.songsObserved || 0, day.errors, live?.errors || 0]
            : [day.day, day.plays, day.skips, day.errors, day.commands];
      const row = document.createElement("tr");
      for (const [index, value] of values.entries()) {
        const cell = document.createElement("td");
        cell.className = index === 0 ? "text-nowrap" : "text-end";
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    const tracks =
      source === "queue"
        ? data.topTracks.map((track) => ({
            label: track.title,
            title: track.title,
            count: track.requests,
            unit: "requests",
          }))
        : source === "radio"
          ? radio.topTracks.map((track) => ({
              label: `${track.title} on ${track.station}`,
              title: track.title,
              station: track.station,
              count: track.observations,
              unit: "songs tracked",
            }))
          : [
              ...(data.topPlays || []).map((track) => ({
                label: `${track.title} · Queue`,
                title: track.title,
                subtitle: "Queue",
                chartLabel: `Queue: ${track.title}`,
                count: track.plays,
                unit: "queued plays",
              })),
              ...radio.topTracks.map((track) => ({
                label: `${track.title} on ${track.station}`,
                title: track.title,
                station: track.station,
                count: track.observations,
                unit: "songs tracked",
              })),
            ]
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
              .slice(0, 10);
    rankedList(
      "top-tracks-data",
      tracks.map((track) => ({
        ...track,
        subtitle: track.station ? ` on ${track.station}` : track.subtitle,
      })),
    );
    document.getElementById("radio-statistics-details").hidden = source === "queue";
    document.getElementById("radio-statistics-breakdown").hidden = source === "queue";
    document.getElementById("radio-statistics-summary").textContent =
      `${radio.totals.songsObserved} songs tracked · ${radio.totals.sessions} sessions · ${Math.round(radio.totals.connectedSeconds / 60)} min on air`;
    rankedList(
      "radio-stations-data",
      radio.stations.map((station) => ({
        title: station.station,
        count: station.songsObserved,
        unit: "songs tracked",
      })),
    );
    rankedList(
      "radio-artists-data",
      radio.topArtists.map((artist) => ({
        title: artist.artist,
        subtitle: ` on ${artist.station}`,
        count: artist.observations,
        unit: "songs tracked",
      })),
    );
    const headings =
      source === "queue"
        ? ["Plays over time", "Top 10 requested tracks", "Commands / plays / skips"]
        : source === "radio"
          ? ["Radio songs over time", "Top 10 radio tracks", "Songs by station"]
          : ["Queue and radio activity", "Top 10 tracks", "Queue and radio"];
    ["plays", "tracks", "distribution"].forEach((name, index) => {
      document.getElementById(`statistics-${name}-heading`).textContent = headings[index];
      document
        .getElementById(`${name}-chart`)
        .setAttribute("aria-label", `${headings[index]}; values are in the data below`);
    });
    document.getElementById("statistics-track-list-heading").textContent = headings[1];
    const { commands, plays, skips } = data.distribution;
    const labels =
      source === "queue"
        ? ["Commands", "Plays", "Skips"]
        : source === "radio"
          ? radio.stations.map((station) => station.station)
          : ["Queued plays", "Radio songs"];
    const counts =
      source === "queue"
        ? [commands, plays, skips]
        : source === "radio"
          ? radio.stations.map((station) => station.songsObserved)
          : [plays, radio.totals.songsObserved];
    summaryMetrics(labels, counts);
    breakdown = { labels, counts };
    renderLegend();
    root.querySelectorAll(".statistics-tooltip").forEach((element) => element.remove());
    charts.forEach((instance) => instance.destroy());
    charts = [];
    if (!window.Chart) {
      status.textContent =
        "Charts could not load. Statistics are available under “View statistics data”.";
      return;
    }
    const datasets = [];
    if (source !== "radio")
      datasets.push({
        label: source === "queue" ? "Plays" : "Queued plays",
        data: data.days.map((day) => day.plays),
        borderColor: colors.primary,
        backgroundColor: gradientFill("primary"),
        tension: 0.35,
        fill: true,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
      });
    if (source !== "queue")
      datasets.push({
        label: "Radio songs",
        data: data.days.map((day) => radioByDay.get(day.day)?.songsObserved || 0),
        borderColor: colors.success,
        backgroundColor: gradientFill("success"),
        tension: 0.35,
        fill: true,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
      });
    charts.push(
      chart(
        "plays-chart",
        "line",
        data.days.map((day) => day.day),
        datasets,
      ),
    );
    charts.push(
      chart(
        "tracks-chart",
        "bar",
        tracks.map((track) => track.chartLabel || track.label),
        [
          {
            label:
              source === "queue"
                ? "Requests"
                : source === "radio"
                  ? "Songs tracked"
                  : "Queued plays / radio songs",
            stations: tracks.map((track) => track.station),
            data: tracks.map((track) => track.count),
            backgroundColor: colors.primary,
            borderRadius: 6,
            borderSkipped: false,
            maxBarThickness: 28,
          },
        ],
      ),
    );
    charts.push(
      chart("distribution-chart", "doughnut", labels, [
        {
          data: counts,
          backgroundColor: seriesColors(colors),
          borderColor: colors.surface,
          borderWidth: 2,
          borderRadius: 4,
          hoverOffset: 4,
        },
      ]),
    );
    status.textContent =
      counts.some((count) => count > 0) ||
      (source !== "queue" && (radio.totals.sessions > 0 || radio.totals.connectedSeconds > 0))
        ? ""
        : "No activity recorded in this period.";
  }
  async function load() {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    status.textContent = "Loading statistics…";
    try {
      const response = await fetch(root.dataset.statisticsUrl, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          `Statistics unavailable (${response.status}). Check your session and try again.`,
        );
      const data = await response.json();
      lastData = data;
      render(data);
    } catch (error) {
      status.textContent = error.message;
      root.querySelectorAll("[data-statistic-value].placeholder-glow").forEach((metric) => {
        metric.classList.remove("placeholder-glow");
        metric.textContent = "—";
      });
    } finally {
      busy = false;
      root.setAttribute("aria-busy", "false");
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void load());
  sourceSelect?.addEventListener("change", () => {
    if (lastData) render(lastData);
  });
  document.addEventListener("sashimi:theme", () => {
    const colors = palette();
    renderLegend();
    root.querySelectorAll(".statistics-tooltip").forEach((element) => {
      element.hidden = true;
    });
    for (const [index, instance] of charts.entries()) {
      for (const dataset of instance.data?.datasets || []) {
        if (index === 2) {
          dataset.backgroundColor = seriesColors(colors);
          dataset.borderColor = colors.surface;
        } else if (index === 0) {
          const token = dataset.label === "Radio songs" ? "success" : "primary";
          dataset.backgroundColor = gradientFill(token);
          dataset.borderColor = colors[token];
        } else {
          dataset.backgroundColor =
            dataset.label === "Radio songs" ? colors.success : colors.primary;
          if (dataset.borderColor) dataset.borderColor = dataset.backgroundColor;
        }
      }
      instance.options.plugins.legend.labels.color = colors.text;
      const tooltip = instance.options.plugins.tooltip;
      if (tooltip) {
        tooltip.backgroundColor = colors.raised;
        tooltip.titleColor = tooltip.bodyColor = colors.foreground;
        tooltip.borderColor = colors.grid;
      }
      for (const scale of Object.values(instance.options.scales || {})) {
        if (scale.ticks) scale.ticks.color = colors.text;
        if (scale.grid) scale.grid.color = translucent(colors.grid, 0.35);
      }
      instance.stop?.();
      instance.update("none");
      instance.render?.();
    }
  });
  void load();
})();
