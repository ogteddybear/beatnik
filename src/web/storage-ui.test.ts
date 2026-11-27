import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("owner quota form saves JSON, refreshes progress and preserves unsaved edits during polling", async () => {
  const html = await ejs.renderFile("src/web/views/guild-detail.ejs", {
    username: "Owner",
    avatarUrl: "",
    isAdmin: true,
    statisticsTab: "events",
    guildId: "123",
    guildName: "Server",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let tick: () => void = () => {
    throw new Error("Polling interval not registered");
  };
  window.setInterval = ((callback: () => void) => {
    tick = callback;
    return 1;
  }) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  let limit = 100;
  let failed = false;
  const posts: RequestInit[] = [];
  const summary = () => ({
    allTime: {},
    ranges: { day: {}, week: {}, month: {} },
    storageUsed: "60 MB",
    storageLimit: `${limit} MB`,
    maxStorageBytes: limit * 1048576,
    storageBytes: 60 * 1048576,
    storagePercentage: (60 / limit) * 100,
    storageOverQuota: 60 > limit,
  });
  window.fetch = async (url, init) => {
    if (init?.method === "POST") {
      posts.push(init);
      if (failed) return new Response("", { status: 403 });
      limit = JSON.parse(String(init.body)).max_storage_mb;
      return Response.json(summary());
    }
    return Response.json(
      String(url).includes("/summary") ? summary() : { events: [], hasMore: false },
    );
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await flush();
    const input = window.document.querySelector<HTMLInputElement>("#max-storage-mb");
    const form = window.document.querySelector<HTMLFormElement>("#quota-settings");
    assert(input && form);
    assert.equal(input.value, "100");
    assert.equal(input.disabled, false);
    input.value = "50";
    tick();
    await flush();
    assert.equal(input.value, "50", "Polling must not overwrite owner's input");
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(String(posts[0].body)), { max_storage_mb: 50 });
    assert.equal(new Headers(posts[0].headers).get("X-Sashimi-Request"), "quota");
    const bar = window.document.querySelector<HTMLElement>("#storage-meter .progress-bar");
    assert.equal(bar?.style.width, "100%");
    assert(bar?.classList.contains("bg-danger"));
    assert.match(window.document.getElementById("quota-status")?.textContent ?? "", /Quota saved/);
    failed = true;
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert.match(
      window.document.getElementById("quota-status")?.textContent ?? "",
      /could not be saved/,
    );
    assert.equal(form.querySelector("button")?.disabled, false);
  } finally {
    window.close();
  }
});
