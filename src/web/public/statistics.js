(() => {
  const root = document.getElementById("statistics");
  if (!root) return;
  const status = document.getElementById("statistics-status");
  const refresh = document.getElementById("refresh-statistics");
  let charts = [];
  let busy = false;
  function chart(id, type, labels, datasets, extra = {}) {
    return new window.Chart(document.getElementById(id), {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#aebbd0" } } },
        ...(type !== "pie"
          ? {
              scales: {
                x: { ticks: { color: "#aebbd0" }, grid: { color: "#52607855" } },
                y: {
                  beginAtZero: true,
                  ticks: { precision: 0, color: "#aebbd0" },
                  grid: { color: "#52607855" },
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
  void load();
})();
