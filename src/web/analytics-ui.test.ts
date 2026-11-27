import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("activity renders recorded names, muted UID and safe download badges", async () => {
  const html = await ejs.renderFile("src/web/views/guild-detail.ejs", {
    username: "Owner",
    avatarUrl: "",
    isAdmin: true,
    statisticsTab: "events",
    guildId: "1",
    guildName: "Server",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  window.setInterval = (() => 1) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  window.fetch = async (url) =>
    Response.json(
      String(url).includes("/summary")
        ? { allTime: {}, storageUsed: "0 B", ranges: { day: {}, week: {}, month: {} } }
        : {
            events: [
              {
                id: 1,
                time: "2026-11-26T00:00:00Z",
                username: "Recorded listener",
                user: "123",
                userId: "123",
                trackName: "<b>Track title</b>",
                eventType: "library",
                action: "download",
                details: "trackId: id",
              },
            ],
            hasMore: false,
          },
    );
  try {
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const row = window.document.querySelector('[data-event-id="1"]');
    assert(row);
    assert.match(row.textContent ?? "", /Recorded listener/);
    assert.equal(row.querySelector("small.text-secondary")?.textContent, "123");
    assert.equal(row.querySelector("strong")?.textContent, "<b>Track title</b>");
    assert.equal(row.querySelector("b"), null);
    assert.equal(row.querySelector('[data-kind="download"]')?.textContent, "download");
  } finally {
    window.close();
  }
});
