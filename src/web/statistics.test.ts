import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
