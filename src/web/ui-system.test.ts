import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const locals = {
  username: "Listener",
  avatarUrl: "",
  isAdmin: true,
  statisticsTab: "events",
  inviteUrl: "/invite",
  guilds: [],
  guildId: "123",
  guildName: "Music club",
  message: "Authorization completed.",
  isAuthenticated: true,
};

for (const view of ["login", "dashboard", "admin", "guild-detail", "invite-result"]) {
  test(`${view} uses the shared theme and responsive viewport`, async () => {
    const html = await ejs.renderFile(`src/web/views/${view}.ejs`, locals);
    const { window } = new JSDOM(html);
    assert(window.document.querySelector('link[href="/static/dashboard.css"]'));
    assert(window.document.querySelector('meta[name="viewport"]'));
    assert(window.document.querySelector("h1"));
    // Dynamic Bootstrap progress widths/heights are the only inline styles.
    assert.equal(window.document.querySelector("[style]:not(.progress):not(.progress-bar)"), null);
    if (["dashboard", "admin", "guild-detail"].includes(view)) {
      assert(window.document.querySelector('nav[aria-label="Main navigation"]'));
    }
    window.close();
  });
}

test("activity has intentional empty, error, and validation feedback", async () => {
  const html = await ejs.renderFile("src/web/views/guild-detail.ejs", locals);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  window.setInterval = (() => 1) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  let failed = false;
  window.fetch = async (url) => {
    if (failed) return new Response("", { status: 503 });
    return Response.json(
      String(url).includes("/summary")
        ? { allTime: {}, storageUsed: "0 B", ranges: { day: {}, week: {}, month: {} } }
        : { events: [], hasMore: false },
    );
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await flush();
    assert.match(
      window.document.getElementById("activity-rows")?.textContent || "",
      /No activity matches/,
    );
    const range = window.document.querySelector<HTMLSelectElement>("#range");
    assert(range);
    range.value = "custom";
    window.document
      .querySelector("#activity-filters")
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
    assert.equal(window.document.getElementById("live-status")?.dataset.state, "warning");
    range.value = "7";
    failed = true;
    window.document
      .querySelector("#activity-filters")
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert.equal(window.document.getElementById("live-status")?.dataset.state, "error");
    assert.match(
      window.document.getElementById("activity-rows")?.textContent || "",
      /couldn’t be loaded/,
    );
    assert.equal(window.document.querySelector<HTMLButtonElement>("#load-older")?.disabled, false);
  } finally {
    window.close();
  }
});

test("theme text and action colors meet normal-text contrast", async () => {
  const css = await readFile("src/web/public/dashboard.css", "utf8");
  const color = (token: string) => {
    const match = css.match(new RegExp(`--${token}:\\s*(#[\\da-f]{6});`, "i"));
    assert(match, `Missing color token: ${token}`);
    const rgb = match[1].slice(1).match(/../g);
    assert(rgb);
    const channels = rgb.map((hex) => {
      const value = parseInt(hex, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const [foreground, background] of [
    ["text-primary", "surface-raised"],
    ["text-secondary", "surface-raised"],
    ["text-primary", "brand-primary"],
    ["accent", "surface-section"],
    ["success", "success-surface"],
    ["warning", "warning-surface"],
    ["error", "error-surface"],
  ]) {
    const a = color(foreground);
    const b = color(background);
    assert(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
      `${foreground} on ${background}`,
    );
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
});
