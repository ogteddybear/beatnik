import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("charts use horizontal rankings and recolor existing canvases when the theme changes", async () => {
  const html = await ejs.renderFile("src/web/views/statistics.ejs", {
    statisticsUrl: "/statistics",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  interface ChartOptions {
    indexAxis: string;
    plugins: { legend: { labels: { color: string } } };
    scales?: Record<string, { ticks: { color: string }; grid: { color: string } }>;
  }
  const options: ChartOptions[] = [];
  let updated = 0;
  Object.assign(dom.window, {
    Chart: class {
      options: ChartOptions;
      constructor(_canvas: unknown, config: { options: ChartOptions }) {
        this.options = config.options;
        options.push(this.options);
      }
      update() {
        updated++;
      }
      destroy() {
        /* No canvas resources in this test. */
      }
    },
  });
  dom.window.fetch = async () =>
    Response.json({
      days: [{ day: "2026-11-27", plays: 1 }],
      topTracks: [{ title: "A long track", requests: 3 }],
      distribution: { commands: 1, plays: 1, skips: 0 },
    });
  try {
    dom.window.document.documentElement.style.setProperty("--text-secondary", "#aab7d1");
    dom.window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(options.length, 3);
    assert.equal(options[1].indexAxis, "y");
    dom.window.document.documentElement.style.setProperty("--text-secondary", "#485b77");
    dom.window.document.dispatchEvent(new dom.window.CustomEvent("sashimi:theme"));
    assert.equal(updated, 3);
    assert(options.every((option) => option.plugins.legend.labels.color === "#485b77"));
    assert.equal(options[0].scales?.x.ticks.color, "#485b77");
  } finally {
    dom.window.close();
  }
});

test("shared layouts avoid broken avatars and provide bounded charts and mobile action layouts", async () => {
  const navbar = await ejs.renderFile("src/web/views/navbar.ejs", {
    avatarUrl: "",
    username: "User",
    isAdmin: true,
    active: "admin",
  });
  assert.doesNotMatch(navbar, /<img/);
  assert.match(navbar, /avatar-placeholder/);
  const css = await readFile("src/web/public/dashboard.css", "utf8");
  assert.match(css, /--bs-btn-color:\s*var\(--on-primary\)/);
  assert.match(css, /\.statistics-chart-tracks\s*\{\s*height:\s*400px/);
  assert.match(css, /\.playlist-handle[\s\S]*?touch-action:\s*none/);
  assert.match(css, /\.responsive-action-form\s*\{[\s\S]*?flex-direction:\s*column/);
  const playlists = await ejs.renderFile("src/web/views/playlists.ejs", {
    avatarUrl: "",
    username: "User",
    isAdmin: false,
  });
  assert.match(playlists, /responsive-action-form/);
});
