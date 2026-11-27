import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

for (const isAdmin of [false, true]) {
  test(`account navigation preserves actions and theme handler (${isAdmin ? "admin" : "member"})`, async () => {
    const html = await ejs.renderFile("src/web/views/navbar.ejs", {
      username: "<Listener>",
      avatarUrl: "",
      active: "servers",
      isAdmin,
    });
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
    const { document } = dom.window;
    try {
      const navigation = document.getElementById("primary-navigation");
      assert(navigation);
      assert(navigation.classList.contains("collapse"));
      assert.deepEqual(
        [...navigation.querySelectorAll("a")].map((link) => link.textContent),
        ["Servers", "Playlists", "Recap", "Stats"],
      );
      assert.equal(
        navigation.querySelector('[aria-current="page"]')?.getAttribute("href"),
        "/servers",
      );
      assert.equal(
        document.querySelector('[data-bs-toggle="collapse"]')?.getAttribute("data-bs-target"),
        "#primary-navigation",
      );
      const menu = document.querySelector(".dropdown-menu");
      assert(menu);
      assert.equal(Boolean(menu.querySelector('a[href="/admin"]')), isAdmin);
      assert.equal(
        menu.querySelector('a[href="/logout"]')?.classList.contains("text-danger"),
        true,
      );
      const toggle = menu.querySelector<HTMLButtonElement>("button[data-theme-toggle]");
      assert(toggle);
      assert.equal(toggle.children.length, 0);
      assert.equal(document.querySelector(".account-menu")?.closest(".navbar-collapse"), null);
      dom.window.eval(await readFile("src/web/public/theme.js", "utf8"));
      document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
      assert.equal(toggle.textContent, "Light mode");
      toggle.click();
      assert.equal(document.documentElement.dataset.bsTheme, "light");
      assert.equal(toggle.textContent, "Dark mode");
      assert.equal(dom.window.localStorage.getItem("sashimi-theme"), "light");
    } finally {
      dom.window.close();
    }
  });
}

test("public stats renders for guests and shared head loads Bootstrap bundle once", async () => {
  const html = await ejs.renderFile("src/web/views/stats.ejs", {
    servers: 3,
    plays: 42,
    uptime: 100,
  });
  const dom = new JSDOM(html);
  try {
    const { document } = dom.window;
    assert.equal(
      document.querySelectorAll(
        'script[src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"]',
      ).length,
      1,
    );
    assert(document.querySelector('nav[aria-label="Public navigation"]'));
    assert.equal(document.querySelector(".account-menu"), null);
    assert.equal(document.querySelector('a[href="/logout"]'), null);
    assert(document.querySelector("[data-theme-toggle]"));
    const styles = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) =>
      link.getAttribute("href"),
    );
    assert(
      styles.indexOf("/static/dashboard.css") >
        styles.findIndex((href) => href?.includes("bootstrap@5.3.3")),
    );
  } finally {
    dom.window.close();
  }
});

test("chart datasets re-read brand and semantic tokens without replacing charts", async () => {
  const html = await ejs.renderFile("src/web/views/statistics.ejs", {
    statisticsUrl: "/statistics",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  interface Dataset {
    label?: string;
    backgroundColor: string | string[];
    borderColor?: string;
  }
  interface Config {
    data: { datasets: Dataset[] };
    options: {
      plugins: { legend: { labels: { color: string } } };
      scales?: Record<string, { ticks: { color: string }; grid: { color: string } }>;
    };
  }
  const instances: Config[] = [];
  let updated = 0;
  Object.assign(dom.window, {
    Chart: class {
      data: Config["data"];
      options: Config["options"];
      constructor(_canvas: unknown, config: Config) {
        this.data = config.data;
        this.options = config.options;
        instances.push(this);
      }
      update() {
        updated++;
      }
      destroy() {
        throw new Error("A theme change must not replace charts");
      }
    },
  });
  dom.window.fetch = async () =>
    Response.json({
      days: [{ day: "2026-11-28", plays: 1 }],
      topTracks: [{ title: "Tonight", requests: 1 }],
      distribution: { commands: 1, plays: 1, skips: 0 },
    });
  try {
    const style = dom.window.document.documentElement.style;
    for (const [name, value] of Object.entries({
      "brand-primary": "#4168ba",
      accent: "#a9bded",
      success: "#9acbb7",
      warning: "#e2c18b",
      error: "#efacb5",
      "text-secondary": "#aab7d1",
      "border-color": "#354460",
    }))
      style.setProperty(`--${name}`, value);
    dom.window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(instances[0].data.datasets[0].borderColor, "#4168ba");
    assert.equal(instances[1].data.datasets[0].backgroundColor, "#4168ba");
    style.setProperty("--success", "#23664e");
    style.setProperty("--warning", "#775000");
    style.setProperty("--error", "#9b2537");
    style.setProperty("--accent", "#254d91");
    dom.window.document.dispatchEvent(new dom.window.CustomEvent("sashimi:theme"));
    assert.deepEqual(Array.from(instances[2].data.datasets[0].backgroundColor), [
      "#4168ba",
      "#23664e",
      "#775000",
      "#254d91",
      "#9b2537",
    ]);
    assert.equal(updated, 3);
    assert.equal(instances.length, 3);
  } finally {
    dom.window.close();
  }
});
