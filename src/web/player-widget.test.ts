import type { PlayerState } from "@/core/player";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("live player widget renders safe titles, progress, upcoming tracks, pauses and idle", async () => {
  const player: PlayerState = {
    status: "playing",
    track: {
      id: "one",
      title: "<script>Track</script>",
      artist: "Artist",
      thumbnail: "https://example.com/cover.jpg",
      durationSeconds: 100,
    },
    progressSeconds: 25,
    progressPercent: 25,
    loopMode: "off",
    nextTracks: Array.from({ length: 7 }, (_, id) => ({
      id: String(id),
      title: `Next ${id}`,
      artist: "Artist",
      thumbnail: "",
      durationSeconds: 60,
    })),
  };
  const guild: { id: string; name: string; iconUrl: null; player: PlayerState | null } = {
    id: "guild",
    name: "Music club",
    iconUrl: null,
    player,
  };
  const html = await ejs.renderFile("src/web/views/dashboard.ejs", {
    username: "Listener",
    avatarUrl: "",
    isAdmin: false,
    guilds: [],
    inviteUrl: "/invite",
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let tick: () => void = () => {
    throw new Error("No poll registered");
  };
  window.setInterval = ((callback: () => void) => {
    tick = callback;
    return 1;
  }) as typeof window.setInterval;
  Object.defineProperty(window.document, "hidden", { value: false });
  window.fetch = async () => Response.json({ guilds: [guild] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
    await flush();
    const root = window.document.getElementById("live-players");
    assert(root);
    assert.equal(root.querySelector("h3")?.textContent, "<script>Track</script>");
    assert.equal(root.querySelector("script"), null);
    assert.equal(root.querySelectorAll("li").length, 5);
    assert.equal(root.querySelector<HTMLElement>(".progress-bar")?.style.width, "25%");
    assert(root.querySelector("img"));
    player.status = "paused";
    tick();
    await flush();
    assert.match(root.textContent ?? "", /paused/);
    assert.match(root.textContent ?? "", /0:25 \/ 1:40/);
    guild.player = null;
    tick();
    await flush();
    assert.match(root.textContent ?? "", /Nothing is playing/);
    assert.equal(root.querySelector("img"), null);
  } finally {
    window.close();
  }
});
