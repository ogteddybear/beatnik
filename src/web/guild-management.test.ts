import type { Client } from "discord.js";
import express from "express";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("guild settings and queue APIs authorize, validate, reject stale writes and preserve the playing track", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-guild-manage-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("../core/db/client");
  const { mountGuildManagement } = await import("./guild-management");
  const { getOrCreateSession } = await import("../core/manager");
  const { getGuildPlayerSettings } = await import("../core/db/guild-settings");
  const session = getOrCreateSession("guild");
  session.player.enqueueTracks(
    ["one", "two", "three"].map((id) => ({
      id,
      providerId: "fake",
      title: id,
      url: "https://example.com",
      channelName: "Artist",
      thumbnailUrl: "",
      length: 60,
      loudness: 0,
      playlistIdx: null,
    })),
    "owner",
  );
  session.queue.currentIndex = 1;
  const client = {
    guilds: {
      cache: new Map([
        [
          "guild",
          {
            id: "guild",
            name: "<script>Server</script>",
            roles: {
              fetch: async (id: string) =>
                id === "123456789012345678" ? { id, managed: false } : null,
            },
          },
        ],
      ]),
    },
  } as unknown as Client;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => !!req.get("X-Test-User")) as typeof req.isAuthenticated;
    next();
  });
  let busy = false;
  mountGuildManagement(
    app,
    client,
    async (req) =>
      req.get("X-Test-User") === "manager" && req.params.guildId === "guild"
        ? { id: "manager", username: "Manager" }
        : null,
    () => ({
      player: session.player,
      voice: {
        runControl: async (action) => {
          if (busy) return false;
          await action();
          return true;
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const base = "/api/dashboard/guilds/guild";
    const request = (
      url: string,
      method = "GET",
      body?: object,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + url, {
        method,
        headers: {
          "X-Test-User": "manager",
          "X-Sashimi-Request": "guild",
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (await request(base + "/queue", "GET", undefined, { "X-Test-User": "" })).status,
      401,
    );
    assert.equal(
      (await request(base + "/settings", "GET", undefined, { "X-Test-User": "member" })).status,
      403,
    );
    assert.equal(
      (await request(base + "/settings", "POST", { volume: 70 }, { "X-Sashimi-Request": "" }))
        .status,
      403,
    );
    assert.equal((await request(base + "/settings", "POST", { volume: -1 })).status, 400);
    assert.equal(
      (await request(base + "/settings", "POST", { autoplay_enabled: "yes" })).status,
      400,
    );
    assert.equal(
      (await request(base + "/settings", "POST", { dj_role_id: "987654321012345678" })).status,
      400,
    );
    assert.equal(
      (
        await request(base + "/settings", "POST", {
          volume: 70,
          autoplay_enabled: true,
          dj_role_id: "123456789012345678",
        })
      ).status,
      200,
    );
    assert.equal(session.player.volume, 70);
    assert.equal(getGuildPlayerSettings("guild").autoplay_enabled, true);
    const initial = (await (await request(base + "/queue")).json()) as {
      revision: string;
      tracks: unknown[];
    };
    assert.equal(initial.tracks.length, 3);
    const reordered = await request(base + "/queue/reorder", "POST", {
      from: 3,
      to: 1,
      revision: initial.revision,
    });
    assert.equal(reordered.status, 200);
    assert.equal(session.queue.nowPlaying?.id, "two");
    assert.equal(
      (
        await request(base + "/queue/reorder", "POST", {
          from: 1,
          to: 2,
          revision: initial.revision,
        })
      ).status,
      409,
    );
    assert.equal((await request(base + "/queue/reorder", "POST", { from: 1, to: 99 })).status, 400);
    busy = true;
    assert.equal((await request(base + "/queue/1", "DELETE")).status, 409);
    busy = false;
    assert.equal((await request(base + "/queue/1", "DELETE")).status, 200);
    assert.equal(session.queue.tracks.length, 2);
    assert.equal(session.queue.nowPlaying?.id, "two");
    const page = await (await request("/dashboard/guilds/guild")).text();
    assert.match(page, /&lt;script&gt;Server&lt;\/script&gt;/);
    assert.match(page, /Sortable.min.js/);
    assert.match(page, /Default volume/);
    assert.equal(
      (await request(base + "/control", "POST", {}, { "X-Sashimi-Request": "control" })).status,
      404,
      "The new router must not intercept the existing control route",
    );
  } finally {
    server.close();
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
