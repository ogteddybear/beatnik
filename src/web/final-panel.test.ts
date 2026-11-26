import type { Provider } from "@/providers";
import type { Client } from "discord.js";
import express from "express";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("recap is user-scoped and honest about missing metadata; bot controls persist and public stats reveal only totals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sashimi-final-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: dir,
    DATABASE_URL: path.join(dir, "library.db"),
  });
  const { db, archiveDb } = await import("../core/db/client");
  const { userRecap } = await import("../core/db/recap");
  const { getBotSettings, isProviderEnabled } = await import("../core/db/bot-settings");
  const { mountFinalPanel } = await import("./final-panel");
  const insert = db.prepare(
    "INSERT INTO GuildEvents (user_id,event_type,action,track_name,metadata,created_at) VALUES (?,'player','play',?,?,?)",
  );
  const now = Date.now();
  insert.run("user", "Song", JSON.stringify({ artist: "Artist", durationSeconds: 120 }), now);
  insert.run("user", "Old Song", "{bad", now);
  insert.run(
    "other",
    "Secret Song",
    JSON.stringify({ artist: "Secret", durationSeconds: 999 }),
    now,
  );
  insert.run("user", "Too Old", "{}", now - 31 * 86400000);
  archiveDb
    .prepare(
      "INSERT INTO GuildEvents (id,user_id,event_type,action,track_name,metadata,created_at) VALUES (100,'user','player','play','Song',?,?)",
    )
    .run(JSON.stringify({ artist: "Artist", durationSeconds: 60 }), now);
  const recap = userRecap("user", now);
  assert.equal(recap.plays, 3);
  assert.equal(recap.measuredPlays, 2);
  assert.equal(recap.durationSeconds, 180);
  assert.equal(recap.topTrack?.name, "Song");
  assert.equal(recap.topArtist?.name, "Artist");
  const presence: unknown[] = [];
  const client = {
    guilds: { cache: new Map([["guild", {}]]) },
    user: {
      presence: { activities: [], status: "online" },
      setPresence: (value: unknown) => {
        presence.push(value);
      },
    },
  } as unknown as Client;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  mountFinalPanel(app, client, (req) =>
    req.get("X-User") ? { id: req.get("X-User") ?? "", username: "User", avatarUrl: "" } : null,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = (url: string, user = "user", body?: object, header = "bot") =>
      fetch(origin + url, {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          "X-User": user,
          "X-Sashimi-Request": header,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await request("/admin/bot", "")).status, 401);
    assert.equal((await request("/admin/bot")).status, 403);
    const settings = { ...getBotSettings(), activity: "Music night", status: "idle" };
    assert.equal((await request("/api/admin/bot", "user", settings)).status, 403);
    assert.equal((await request("/api/admin/bot", "258189484053495809", settings, "")).status, 403);
    assert.equal(
      (await request("/api/admin/bot", "258189484053495809", { ...settings, status: "bad" }))
        .status,
      400,
    );
    settings.providers.youtube = false;
    assert.equal((await request("/api/admin/bot", "258189484053495809", settings)).status, 200);
    assert.equal(getBotSettings().activity, "Music night");
    assert.equal(isProviderEnabled("youtube"), false);
    assert.equal(isProviderEnabled("spotify-link-resolver"), false);
    assert.equal(isProviderEnabled("soundcloud"), true);
    const { resolveStream } = await import("../core/resolvers");
    await assert.rejects(
      resolveStream("guild", "track", { id: "youtube" } as Provider),
      /disabled/,
    );
    assert.match(JSON.stringify(presence), /Music night/);
    const page = await (await request("/recap")).text();
    assert.match(page, /Song/);
    assert.doesNotMatch(page, /Secret Song/);
    assert.match(page, /not actual listening time/);
    assert.equal((await request("/recap", "")).status, 302);
    const stats = await (await request("/stats", "")).text();
    assert.match(stats, /Total servers/);
    assert.doesNotMatch(stats, /Secret Song|Artist|Music night/);
    assert.equal((await request("/manifest.json", "")).status, 200);
    assert.equal((await request("/sw.js", "")).headers.get("service-worker-allowed"), "/");
  } finally {
    server.close();
    db.close();
    archiveDb.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("theme toggle restores preference and persists changes without unsafe HTML", async () => {
  const dom = new JSDOM(
    '<html data-bs-theme="dark"><head><meta name="theme-color"></head><body><button data-theme-toggle>Theme</button></body></html>',
    { runScripts: "outside-only", url: "https://sashimi.example" },
  );
  try {
    dom.window.localStorage.setItem("sashimi-theme", "light");
    dom.window.eval(await readFile("src/web/public/theme.js", "utf8"));
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    assert.equal(dom.window.document.documentElement.dataset.bsTheme, "light");
    dom.window.document.querySelector<HTMLButtonElement>("button")?.click();
    assert.equal(dom.window.localStorage.getItem("sashimi-theme"), "dark");
  } finally {
    dom.window.close();
  }
});
