(() => {
  const root = document.getElementById("statistics");
  if (!root) return;
  const status = document.getElementById("statistics-status");
  const refresh = document.getElementById("refresh-statistics");
  let charts = [];
  let busy = false;
  let lastData;
  const sourceSelect = document.getElementById("statistics-source");
  function palette() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--text-secondary").trim() || "#aab7d1",
      grid: style.getPropertyValue("--border-color").trim() || "#354460",
    };
  }
  function chart(id, type, labels, datasets, extra = {}) {
    const colors = palette();
    return new window.Chart(document.getElementById(id), {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: type === "bar" ? "y" : "x",
        plugins: { legend: { labels: { color: colors.text } } },
        ...(type !== "pie"
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
                  grid: { color: colors.grid },
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
                  grid: { color: colors.grid },
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
    const columns =
      source === "radio"
        ? ["Day", "Songs observed", "Sessions", "Connected minutes", "Errors", "Reconnects"]
        : source === "all"
          ? ["Day", "Queued plays", "Radio songs observed", "Queue errors", "Radio errors"]
          : ["Day", "Plays", "Skips", "Errors", "Commands"];
    const header = document.getElementById("statistics-columns");
    header.replaceChildren();
    for (const label of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
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
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    const tracks =
      source === "queue"
        ? data.topTracks.map((track) => ({
            label: track.title,
            count: track.requests,
            unit: "requests",
          }))
        : source === "radio"
          ? radio.topTracks.map((track) => ({
              label: `${track.title} on ${track.station}`,
              station: track.station,
              count: track.observations,
              unit: "songs tracked",
            }))
          : [
              ...(data.topPlays || []).map((track) => ({
                label: `${track.title} · Queue`,
                chartLabel: `Queue: ${track.title}`,
                count: track.plays,
                unit: "queued plays",
              })),
              ...radio.topTracks.map((track) => ({
                label: `${track.title} on ${track.station}`,
                station: track.station,
                count: track.observations,
                unit: "songs tracked",
              })),
            ]
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
              .slice(0, 10);
    const top = document.getElementById("top-tracks-data");
    top.replaceChildren();
    for (const track of tracks) {
      const item = document.createElement("li");
      item.textContent = `${track.label}: ${track.count} ${track.unit}`;
      top.append(item);
    }
    document.getElementById("radio-statistics-details").hidden = source === "queue";
    document.getElementById("radio-statistics-breakdown").hidden = source === "queue";
    document.getElementById("radio-statistics-summary").textContent =
      `${radio.totals.songsObserved} songs tracked · ${radio.totals.sessions} sessions · ${Math.round(radio.totals.connectedSeconds / 60)} min on air`;
    for (const [id, labels] of [
      [
        "radio-stations-data",
        radio.stations.map(
          (station) => `${station.station}: ${station.songsObserved} songs tracked`,
        ),
      ],
      [
        "radio-artists-data",
        radio.topArtists.map(
          (artist) => `${artist.artist} on ${artist.station}: ${artist.observations} songs tracked`,
        ),
      ],
    ]) {
      const list = document.getElementById(id);
      list.replaceChildren();
      for (const label of labels.length ? labels : ["No radio activity recorded in this period."]) {
        const item = document.createElement("li");
        item.textContent = label;
        list.append(item);
      }
    }
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
    document.getElementById("distribution-data").textContent = labels
      .map((label, index) => `${label}: ${counts[index]}`)
      .join(" · ");
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
        borderColor: "#5c9dff",
        backgroundColor: "#5c9dff",
      });
    if (source !== "queue")
      datasets.push({
        label: "Radio songs",
        data: data.days.map((day) => radioByDay.get(day.day)?.songsObserved || 0),
        borderColor: "#35b995",
        backgroundColor: "#35b995",
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
            backgroundColor: "#5c9dff",
          },
        ],
      ),
    );
    charts.push(
      chart("distribution-chart", "pie", labels, [
        {
          data: counts,
          backgroundColor: ["#5c9dff", "#35b995", "#e4ad47", "#b085ef", "#e07d8d"],
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
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void load());
  sourceSelect?.addEventListener("change", () => {
    if (lastData) render(lastData);
  });
  document.addEventListener("sashimi:theme", () => {
    const colors = palette();
    for (const instance of charts) {
      instance.options.plugins.legend.labels.color = colors.text;
      for (const scale of Object.values(instance.options.scales || {})) {
        if (scale.ticks) scale.ticks.color = colors.text;
        if (scale.grid) scale.grid.color = colors.grid;
      }
      instance.stop?.();
      instance.update("none");
      instance.render?.();
    }
  });
  void load();
})();
