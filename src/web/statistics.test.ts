import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("radio and all-source charts identify stations without inflating queued plays", async () => {
  const html = await ejs.renderFile("src/web/views/statistics.ejs", {
    statisticsUrl: "/api/dashboard/statistics",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  const charts = new Map<
    string,
    { data: { labels: string[]; datasets: { label?: string; data: number[] }[] } }
  >();
  window.Chart = class {
    constructor(
      canvas: HTMLCanvasElement,
      config: { data: { labels: string[]; datasets: { label?: string; data: number[] }[] } },
    ) {
      charts.set(canvas.id, config);
    }
    destroy() {
      return undefined;
    }
  };
  window.fetch = async () =>
    Response.json({
      days: [{ day: "2026-11-27", plays: 3, skips: 1, errors: 0, commands: 2 }],
      topTracks: [{ title: "Queued song", requests: 4 }],
      topPlays: [{ title: "Queued song", plays: 3 }],
      distribution: { commands: 2, plays: 3, skips: 1 },
      radio: {
        days: [
          {
            day: "2026-11-27",
            songsObserved: 2,
            sessions: 1,
            connectedSeconds: 120,
            errors: 0,
            reconnects: 1,
          },
        ],
        totals: { songsObserved: 2, sessions: 1, connectedSeconds: 120, errors: 0, reconnects: 1 },
        stations: [
          {
            station: "TechnoBase.FM",
            service: "We aRe oNe",
            songsObserved: 1,
            sessions: 1,
            connectedSeconds: 120,
          },
          {
            station: "HouseTime.FM",
            service: "We aRe oNe",
            songsObserved: 1,
            sessions: 0,
            connectedSeconds: 0,
          },
        ],
        topTracks: ["TechnoBase.FM", "HouseTime.FM"].map((station) => ({
          title: "<script>Cascada</script>",
          station,
          service: "We aRe oNe",
          observations: 1,
        })),
        topArtists: [
          {
            artist: "Alex Megane x Timster & Ninth",
            station: "TechnoBase.FM",
            service: "We aRe oNe",
            observations: 1,
          },
        ],
      },
    });
  try {
    window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const select = window.document.querySelector<HTMLSelectElement>("#statistics-source");
    assert.ok(select);
    assert.equal(select.value, "queue");
    assert.ok(select.closest(".statistics-controls"));
    assert.equal(window.document.getElementById("statistics-source-note"), null);
    assert.doesNotMatch(
      window.document.body.textContent ?? "",
      /Neither proves|incomplete historical/,
    );
    assert.equal(
      window.document.querySelector("#radio-statistics-details")?.hasAttribute("hidden"),
      true,
    );
    assert.deepEqual(
      Array.from(charts.get("distribution-chart")?.data.datasets[0].data ?? []),
      [2, 3, 1],
    );
    select.value = "radio";
    select.dispatchEvent(new window.Event("change"));
    const tracks = window.document.getElementById("top-tracks-data");
    assert.match(tracks?.textContent ?? "", /on TechnoBase.FM/);
    assert.match(tracks?.textContent ?? "", /HouseTime.FM/);
    assert.equal(tracks?.querySelector("script"), null);
    assert.match(
      window.document.querySelector("#radio-statistics-summary")?.textContent ?? "",
      /2 min on air/,
    );
    assert.match(
      window.document.getElementById("radio-artists-data")?.textContent ?? "",
      /Alex Megane x Timster & Ninth on TechnoBase.FM/,
    );
    assert.doesNotMatch(window.document.body.textContent ?? "", /We aRe oNe/);
    assert.equal(charts.get("plays-chart")?.data.datasets[0].label, "Radio songs");
    select.value = "all";
    select.dispatchEvent(new window.Event("change"));
    assert.equal(charts.get("plays-chart")?.data.datasets.length, 2);
    assert.deepEqual(
      Array.from(charts.get("distribution-chart")?.data.datasets[0].data ?? []),
      [3, 2],
    );
    const queuedRow = [...(tracks?.children ?? [])].find(
      (row) => row.querySelector(".statistics-ranked-title > span")?.textContent === "Queued song",
    );
    assert.equal(queuedRow?.querySelector("small")?.textContent, "Queue");
    assert.equal(queuedRow?.querySelector(".statistics-count")?.textContent, "3");
    assert.match(tracks?.textContent ?? "", /TechnoBase.FM/);
    assert.equal(tracks?.classList.contains("list-group"), true);
    assert.equal(
      window.document.querySelectorAll("#distribution-data .statistics-summary-metric").length,
      2,
    );
    assert.deepEqual(
      [...window.document.querySelectorAll("#distribution-data .tabular-nums")].map(
        (value) => value.textContent,
      ),
      ["3", "2"],
    );
    assert.equal(
      window.document
        .querySelector("#statistics-table-caption")
        ?.classList.contains("visually-hidden"),
      true,
    );
    assert(window.document.querySelector("#statistics-columns")?.closest("thead.sticky-top"));
    assert(
      window.document
        .querySelector("#statistics-data")
        ?.closest("table")
        ?.parentElement?.classList.contains("statistics-daily-scroll"),
    );
    assert(
      [...window.document.querySelectorAll("#statistics-columns th")]
        .slice(1)
        .every((cell) => cell.classList.contains("text-end")),
    );
    assert(
      [...window.document.querySelectorAll("#statistics-data tr:first-child td")]
        .slice(1)
        .every((cell) => cell.classList.contains("text-end")),
    );
  } finally {
    window.close();
  }
});

test("statistics render charts and safe fallback data, refresh and show fetch failures", async () => {
  const html = await ejs.renderFile("src/web/views/statistics.ejs", {
    statisticsUrl: "/api/dashboard/statistics",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let created = 0;
  let destroyed = 0;
  Object.assign(window, {
    Chart: class {
      constructor() {
        created++;
      }
      destroy() {
        destroyed++;
      }
    },
  });
  const data = {
    days: [{ day: "2026-11-27", plays: 2, skips: 1, errors: 1, commands: 3 }],
    topTracks: [{ title: "<script>Song</script>", requests: 4 }],
    distribution: { commands: 3, plays: 2, skips: 1 },
  };
  window.fetch = async () => Response.json(data);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    await flush();
    assert.equal(created, 3);
    assert.equal(window.document.querySelector("#top-tracks-data script"), null);
    assert.match(
      window.document.querySelector("#top-tracks-data")?.textContent ?? "",
      /<script>Song/,
    );
    const refresh = window.document.querySelector<HTMLButtonElement>("#refresh-statistics");
    assert(refresh);
    refresh.click();
    await flush();
    assert.equal(destroyed, 3);
    window.fetch = async () => new Response("", { status: 403 });
    refresh.click();
    await flush();
    assert.match(window.document.querySelector("#statistics-status")?.textContent ?? "", /403/);
    assert.equal(refresh.disabled, false);
    Object.assign(window, { Chart: undefined });
    window.fetch = async () => Response.json(data);
    refresh.click();
    await flush();
    assert.match(
      window.document.querySelector("#statistics-status")?.textContent ?? "",
      /View statistics data/,
    );
  } finally {
    window.close();
  }
});
