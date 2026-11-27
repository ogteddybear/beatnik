import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const guild = {
  id: "123",
  name: "Music club",
  iconUrl: null,
  plays: 1,
  requests: 2,
  skips: 0,
  stops: 0,
  commands: 3,
  storageUsed: "12 B",
  recent: { plays: 1, adds: 0, commands: 3, errors: 0 },
};
const locals = {
  username: "Listener",
  avatarUrl: "",
  isAdmin: true,
  statisticsTab: "events",
  inviteUrl: "/invite",
  guilds: [guild],
  guildId: "123",
  guildName: guild.name,
};
const counts = { plays: 1, requests: 2, adds: 0, skips: 0, stops: 0, commands: 3, errors: 0 };
const summary = {
  allTime: { ...counts, commands_used: 3 },
  storageUsed: "12 B",
  ranges: { day: counts, week: counts, month: counts },
};
const activity = {
  events: [
    {
      id: 1,
      time: "2026-11-25T12:00:00Z",
      user: "Listener",
      userId: "1",
      eventType: "player",
      action: "play",
      details: "trackId: music",
    },
  ],
  hasMore: false,
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const view of ["admin", "dashboard", "guild-detail"]) {
  for (const failFirst of [false, true]) {
    test(`${view}: first-load ${failFirst ? "failure and retry" : "skeletons"}; polling retains data`, async () => {
      const html = await ejs.renderFile(`src/web/views/${view}.ejs`, locals);
      const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
      const { window } = dom;
      const pending: { url: string; resolve: (value: Response) => void }[] = [];
      let tick: () => void = () => {
        throw new Error("Interval not installed");
      };
      window.setInterval = ((fn: () => void) => {
        tick = fn;
        return 1;
      }) as typeof window.setInterval;
      Object.defineProperty(window.document, "hidden", { value: false });
      window.fetch = (url) =>
        new Promise<Response>((resolve) => {
          pending.push({ url: String(url), resolve });
        });
      const settle = async (failed: boolean) => {
        for (const request of pending.splice(0)) {
          const body = request.url.includes("/summary")
            ? summary
            : request.url.includes("/events")
              ? activity
              : { guilds: [guild] };
          request.resolve(failed ? new Response("", { status: 503 }) : Response.json(body));
        }
        await flush();
      };
      try {
        assert(window.document.querySelector(".placeholder-glow .placeholder"));
        assert(window.document.querySelector('link[href*="bootstrap@5.3.3"]'));
        assert(window.document.querySelector("[data-skeleton]"));
        window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
        await flush();
        assert(
          window.document.querySelector("[data-skeleton]"),
          "pending request retains skeleton",
        );
        await settle(failFirst);
        assert.equal(
          window.document.querySelector("[data-skeleton]"),
          null,
          "settled requests remove all skeletons",
        );
        assert.equal(
          window.document.querySelector(
            "#guild-list .placeholder, #activity-rows .placeholder, #range-stats .placeholder",
          ),
          null,
        );
        if (failFirst) {
          const buttons = [...window.document.querySelectorAll<HTMLButtonElement>("button")].filter(
            (b) => b.textContent === "Try again",
          );
          assert(buttons.length >= 1);
          for (const button of buttons) button.click();
          await settle(false);
          assert.equal(window.document.querySelector("[data-load-error]"), null);
        }
        const selector = view === "guild-detail" ? '[data-event-id="1"]' : '[data-guild-id="123"]';
        const content = window.document.querySelector(selector);
        assert(content);
        tick();
        await flush();
        assert.equal(window.document.querySelector("[data-skeleton]"), null);
        assert.equal(
          window.document.querySelector(selector),
          content,
          "pending poll retains existing content",
        );
        await settle(true);
        assert.equal(
          window.document.querySelector(selector),
          content,
          "failed poll retains existing content",
        );
        tick();
        await flush();
        await settle(false);
        assert.equal(
          window.document.querySelector(selector),
          content,
          "successful poll reconciles content",
        );
        assert.equal(window.document.querySelector("[data-skeleton]"), null);
      } finally {
        window.close();
      }
    });
  }
}

test("loading uses Bootstrap placeholders without a custom animation", async () => {
  const css = await readFile("src/web/public/dashboard.css", "utf8");
  assert.doesNotMatch(css, /@keyframes|radial-gradient/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
