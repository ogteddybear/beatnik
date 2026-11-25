import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("owner infrastructure panel renders, refreshes, clamps bars and tolerates outages", async () => {
  const infrastructure = {
    uptime: "3d 4h 12m",
    memory: { text: "150 MB / 1 GB", percentage: 15 },
    cpu: { text: "120%", percentage: 120 },
    volume: null,
    volumeSource: "Fly Prometheus",
    loadAverage: "1.2 / 1.0 / 0.8",
    coreCount: 1,
  };
  const html = await ejs.renderFile("src/web/views/admin.ejs", {
    username: "Owner",
    avatarUrl: "",
    isAdmin: true,
    guilds: [],
    infrastructure,
    FLY_API_TOKEN: "never-render-this-secret",
  });
  assert.doesNotMatch(html, /never-render-this-secret|FLY_API_TOKEN/);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let tick: () => void = () => {
    throw new Error("No poll registered");
  };
  window.setInterval = ((fn: () => void) => {
    tick = fn;
    return 1;
  }) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  let failed = false;
  window.fetch = async (url) =>
    String(url).includes("/infrastructure")
      ? failed
        ? new Response("", { status: 503 })
        : Response.json(infrastructure)
      : Response.json({ guilds: [] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await flush();
    const panel = window.document.getElementById("infrastructure-health");
    assert(panel);
    assert.equal(panel.querySelector("[data-infra-uptime]")?.textContent, "3d 4h 12m");
    assert.equal(
      panel.querySelector<HTMLElement>('[data-infra-meter="cpu"] .progress-bar')?.style.width,
      "100%",
    );
    assert(panel.querySelector('[data-infra-meter="cpu"] .bg-danger'));
    assert.equal(panel.querySelector<HTMLElement>('[data-infra-meter="volume"]')?.hidden, true);
    failed = true;
    tick();
    await flush();
    assert.equal(panel.querySelector('[data-infra-value="memory"]')?.textContent, "Unavailable");
    assert.equal(panel.querySelector<HTMLElement>('[data-infra-meter="memory"]')?.hidden, true);
    assert.equal(
      window.document.getElementById("guild-total")?.textContent,
      "0 total",
      "Infrastructure failure does not break guild refresh",
    );
  } finally {
    window.close();
  }
});
