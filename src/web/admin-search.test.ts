import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("owner search safely renders results, paginates and exposes errors", async () => {
  const html = await ejs.renderFile("src/web/views/admin-statistics.ejs", {
    username: "Owner",
    avatarUrl: "",
    isAdmin: true,
    statisticsTab: "events",
    guilds: [],
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let count = 0;
  window.fetch = async (url) => {
    count++;
    if (count === 2) assert.match(String(url), /before=50/);
    return count === 3
      ? new Response("", { status: 403 })
      : Response.json({
          events: [
            {
              id: 50,
              created_at: 1000,
              username: "<script>Owner</script>",
              track_name: "<b>Song</b>",
              guild_id: "guild",
              event_type: "player",
              action: "play",
            },
          ],
          nextBefore: count === 1 ? 50 : null,
        });
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/admin-search.js", "utf8"));
    const input = window.document.querySelector<HTMLInputElement>("#event-search-query");
    const form = window.document.querySelector("#admin-search");
    const more = window.document.querySelector<HTMLButtonElement>("#event-search-more");
    assert(input && form && more);
    input.value = "Song";
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert.equal(window.document.querySelector("#event-search-results script"), null);
    assert.match(
      window.document.querySelector("#event-search-results")?.textContent ?? "",
      /<script>Owner/,
    );
    assert.equal(more.hidden, false);
    more.click();
    await flush();
    assert.equal(window.document.querySelectorAll("#event-search-results tr").length, 2);
    assert.equal(more.hidden, true);
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert.match(window.document.querySelector("#event-search-status")?.textContent ?? "", /403/);
  } finally {
    window.close();
  }
});
