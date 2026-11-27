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
          { artist: "Cascada", station: "TechnoBase.FM", service: "We aRe oNe", observations: 1 },
        ],
      },
    });
  try {
    window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const select = window.document.querySelector<HTMLSelectElement>("#statistics-source");
    assert.ok(select);
    assert.equal(select.value, "queue");
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
    assert.match(tracks?.textContent ?? "", /TechnoBase.FM.*We aRe oNe/);
    assert.match(tracks?.textContent ?? "", /HouseTime.FM/);
    assert.equal(tracks?.querySelector("script"), null);
    assert.match(
      window.document.querySelector("#radio-statistics-summary")?.textContent ?? "",
      /2.0 connected broadcast minutes/,
    );
    assert.equal(charts.get("plays-chart")?.data.datasets[0].label, "Radio songs observed");
    select.value = "all";
    select.dispatchEvent(new window.Event("change"));
    assert.equal(charts.get("plays-chart")?.data.datasets.length, 2);
    assert.deepEqual(
      Array.from(charts.get("distribution-chart")?.data.datasets[0].data ?? []),
      [3, 2],
    );
    assert.match(tracks?.textContent ?? "", /Queued song · Queue/);
    assert.match(tracks?.textContent ?? "", /TechnoBase.FM/);
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
