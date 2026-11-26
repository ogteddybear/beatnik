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
  let pendingControl!: (response: Response) => void;
  const controls: RequestInit[] = [];
  let denied = false;
  window.fetch = async (_url, options) => {
    if (options?.method === "POST") {
      controls.push(options);
      if (denied) return new Response("", { status: 403 });
      return new Promise<Response>((resolve) => {
        pendingControl = resolve;
      });
    }
    return Response.json({ guilds: [guild] });
  };
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
    root.querySelector<HTMLButtonElement>('[data-player-action="pause"]')?.click();
    assert.equal(root.querySelectorAll("button:disabled").length, 3);
    assert(root.querySelector(".spinner-border"));
    assert.deepEqual(JSON.parse(String(controls[0].body)), { action: "pause" });
    assert.equal(new Headers(controls[0].headers).get("X-Sashimi-Request"), "control");
    player.status = "paused";
    tick();
    await flush();
    assert(
      root.querySelector(".spinner-border"),
      "Polling must preserve pending state even after the action takes effect",
    );
    pendingControl(Response.json({ player }));
    await flush();
    assert.equal(root.querySelector(".spinner-border"), null);
    assert.equal(root.querySelectorAll("button:disabled").length, 0);
    assert(root.querySelector('[data-player-action="resume"]'));
    denied = true;
    root.querySelector<HTMLButtonElement>('[data-player-action="skip"]')?.click();
    await flush();
    assert.match(
      window.document.getElementById("player-control-status")?.textContent ?? "",
      /permission/,
    );
    assert.equal(controls.length, 2, "Failed controls must not be automatically retried");
    denied = false;
    tick();
    await flush();
    assert.match(root.textContent ?? "", /paused/);
    assert.match(root.textContent ?? "", /0:25 \/ 1:40/);
    root.querySelector<HTMLButtonElement>('[data-player-action="stop"]')?.click();
    assert(root.querySelector(".spinner-border"));
    guild.player = null;
    pendingControl(Response.json({ player: null }));
    await flush();
    assert.match(root.textContent ?? "", /Nothing is playing/);
    assert.equal(root.querySelector("img"), null);
  } finally {
    window.close();
  }
});
