(() => {
  const root = document.getElementById("statistics");
  if (!root) return;
  const status = document.getElementById("statistics-status");
  const refresh = document.getElementById("refresh-statistics");
  let charts = [];
  let busy = false;
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
                            return label.length > 18 ? label.slice(0, 17) + "…" : label;
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
      const rows = document.getElementById("statistics-data");
      rows.replaceChildren();
      for (const day of data.days) {
        const row = document.createElement("tr");
        for (const value of [day.day, day.plays, day.skips, day.errors, day.commands]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        rows.append(row);
      }
      const top = document.getElementById("top-tracks-data");
      top.replaceChildren();
      for (const track of data.topTracks) {
        const item = document.createElement("li");
        item.textContent = `${track.title}: ${track.requests} requests`;
        top.append(item);
      }
      const { commands, plays, skips } = data.distribution;
      document.getElementById("distribution-data").textContent =
        `Commands: ${commands} · Plays: ${plays} · Skips: ${skips}`;
      charts.forEach((instance) => instance.destroy());
      charts = [];
      if (!window.Chart) {
        status.textContent =
          "Charts could not load. Statistics are available under “View statistics data”.";
        return;
      }
      charts.push(
        chart(
          "plays-chart",
          "line",
          data.days.map((day) => day.day),
          [
            {
              label: "Plays",
              data: data.days.map((day) => day.plays),
              borderColor: "#5c9dff",
              backgroundColor: "#5c9dff",
            },
          ],
        ),
      );
      charts.push(
        chart(
          "tracks-chart",
          "bar",
          data.topTracks.map((track) => track.title),
          [
            {
              label: "Requests",
              data: data.topTracks.map((track) => track.requests),
              backgroundColor: "#5c9dff",
            },
          ],
        ),
      );
      charts.push(
        chart(
          "distribution-chart",
          "pie",
          ["Commands", "Plays", "Skips"],
          [
            {
              data: [commands, plays, skips],
              backgroundColor: ["#5c9dff", "#35b995", "#e4ad47"],
            },
          ],
        ),
      );
      status.textContent =
        commands + plays + skips
          ? "Statistics updated."
          : "No commands, plays or skips recorded in this period.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void load());
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
