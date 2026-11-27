import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const locals = {
  username: "Owner",
  avatarUrl: "",
  isAdmin: true,
  guildId: "123",
  guildName: "Music club",
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("server overview fetches only aggregates and renders KPIs, doughnut and safe HTML legend", async () => {
  const html = await ejs.renderFile("src/web/views/guild-detail.ejs", locals);
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://sashimi.example/admin/guild/123",
  });
  const { window } = dom;
  interface ChartConfig {
    type: string;
    data: { datasets: Record<string, unknown>[] };
    options: Record<string, unknown>;
  }
  const configs: ChartConfig[] = [];
  Object.assign(window, {
    Chart: class {
      options: ChartConfig["options"];
      data: ChartConfig["data"];
      constructor(_canvas: unknown, config: ChartConfig) {
        configs.push(config);
        this.options = config.options;
        this.data = config.data;
      }
      destroy() {
        /* No canvas in JSDOM. */
      }
    },
  });
  const requests: string[] = [];
  let settle: (response: Response) => void = () => {
    throw new Error("No request");
  };
  window.fetch = (url) => {
    requests.push(String(url));
    return new Promise<Response>((resolve) => {
      settle = resolve;
    });
  };
  try {
    assert.equal(window.document.querySelector("#activity-rows"), null);
    assert.equal(
      window.document.querySelector('[aria-current="page"][href="/admin/guild/123"]')?.textContent,
      "Overview",
    );
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    assert.equal(requests.length, 0, "the legacy history controller must not run on overview");
    window.eval(await readFile("src/web/public/statistics.js", "utf8"));
    assert.deepEqual(requests, ["/api/admin/guilds/123/statistics"]);
    assert.equal(window.document.querySelectorAll("[data-statistic-value] .placeholder").length, 4);
    settle(
      Response.json({
        days: [{ day: "2026-11-28", plays: 12, skips: 2, errors: 1, commands: 18 }],
        topTracks: [{ title: "<b>Tonight</b>", requests: 4 }],
        distribution: { plays: 12, commands: 18, skips: 2 },
      }),
    );
    await flush();
    assert.deepEqual(
      [...window.document.querySelectorAll("[data-statistic-value]")].map((el) => el.textContent),
      ["12", "18", "2", "1"],
    );
    assert.equal(window.document.querySelector("#statistics")?.getAttribute("aria-busy"), "false");
    assert.equal(configs[0].data.datasets[0].tension, 0.35);
    assert.equal(typeof configs[0].data.datasets[0].backgroundColor, "function");
    assert.equal(configs[1].data.datasets[0].borderRadius, 6);
    assert.equal(configs[2].type, "doughnut");
    assert.equal(configs[2].options.cutout, "68%");
    assert.equal(configs[2].options.scales, undefined);
    assert.equal(configs[2].data.datasets[0].borderWidth, 2);
    assert.equal(configs[2].data.datasets[0].borderRadius, 4);
    assert.match(window.document.querySelector("#distribution-legend")?.textContent ?? "", /56.3%/);
    assert.equal(window.document.querySelector("#top-tracks-data b"), null);
  } finally {
    window.close();
  }
});

test("server history retains filters, skeletons and cursor pagination without fetching charts", async () => {
  const html = await ejs.renderFile("src/web/views/guild-detail.ejs", {
    ...locals,
    statisticsTab: "events",
  });
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://sashimi.example/admin/guild/123?tab=events",
  });
  const { window } = dom;
  const requests: string[] = [];
  window.setInterval = (() => 1) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  window.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.includes("/summary"))
      return Response.json({
        allTime: {},
        ranges: { day: {}, week: {}, month: {} },
        storageUsed: "0 B",
      });
    const older = path.includes("before=");
    return Response.json({
      events: [
        {
          id: older ? 3 : 4,
          time: "2026-11-28T00:00:00Z",
          username: "<b>Owner</b>",
          eventType: "player",
          action: "play",
          details: "Song",
        },
      ],
      hasMore: !older,
    });
  };
  try {
    assert.equal(window.document.querySelector("#statistics"), null);
    assert(window.document.querySelector("#activity-rows [data-skeleton]"));
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await flush();
    const older = window.document.querySelector<HTMLButtonElement>("#load-older");
    assert(older && !older.hidden);
    older.click();
    await flush();
    assert(requests.some((path) => path.includes("before=4")));
    assert.equal(window.document.querySelectorAll("#activity-rows [data-event-id]").length, 2);
    assert.equal(older.hidden, true);
    assert.equal(window.document.querySelector("#activity-rows b"), null);
    const action = window.document.querySelector<HTMLInputElement>("#action");
    assert(action);
    action.value = "play";
    window.document
      .querySelector("#activity-filters")
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert(requests.some((path) => path.includes("action=play")));
    assert.equal(
      requests.some((path) => path.includes("/statistics")),
      false,
    );
  } finally {
    window.close();
  }
});

test("global statistics uses dedicated server-rendered subviews and a light initial event payload", async () => {
  for (const statisticsTab of ["overview", "events"]) {
    const html = await ejs.renderFile("src/web/views/admin-statistics.ejs", {
      ...locals,
      statisticsTab,
    });
    const { window } = new JSDOM(html);
    try {
      assert.equal(
        Boolean(window.document.querySelector("#statistics")),
        statisticsTab === "overview",
      );
      assert.equal(
        Boolean(window.document.querySelector("#event-search-results")),
        statisticsTab === "events",
      );
      assert.equal(window.document.querySelectorAll("#event-search-results tr").length, 0);
      assert.equal(
        window.document.querySelectorAll('nav[aria-label="Statistics views"] a').length,
        2,
      );
      assert.equal(window.document.querySelector('script[src="/static/dashboard-live.js"]'), null);
    } finally {
      window.close();
    }
  }
});
