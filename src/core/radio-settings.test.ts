import type { Provider, ProviderTrack } from "@/providers";
import Database from "better-sqlite3";
import type { ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("guild settings persist volume; autoplay is bounded, cancellable and only runs on natural completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-radio-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./db/client");
  try {
    const { runMigrations } = await import("./db/migrations");
    const legacy = new Database(":memory:");
    try {
      legacy.exec(`CREATE TABLE GuildSettings (guild_id TEXT PRIMARY KEY, max_storage_bytes INTEGER DEFAULT 104857600);
        INSERT INTO GuildSettings VALUES ('legacy', 9999);
        CREATE TABLE Migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE UserPlaylistTrack (id INTEGER PRIMARY KEY);`);
      for (const name of [
        "001_loudness_nullable_and_real",
        "002_provider_id",
        "003_guild_stats_event_counters",
        "004_guild_event_names",
        "005_guild_storage_quota",
        "006_sessions_and_user_playlists",
        "007_spotify_user_tokens",
      ])
        legacy.prepare("INSERT INTO Migration (name) VALUES (?)").run(name);
      runMigrations(legacy);
      runMigrations(legacy);
      assert.deepEqual(legacy.prepare("SELECT * FROM GuildSettings").get(), {
        guild_id: "legacy",
        max_storage_bytes: 9999,
        volume: 100,
        autoplay_enabled: 0,
        dj_role_id: null,
        default_text_channel_id: null,
      });
    } finally {
      legacy.close();
    }
    const {
      getGuildPlayerSettings,
      updateGuildPlayerSettings,
      setGuildStorageLimit,
      getGuildStorageLimit,
    } = await import("./db/guild-settings");
    const { CorePlayer } = await import("./player");
    const { Queue } = await import("./queue");
    const { getLatestEvents } = await import("./db/guild-events");
    assert.deepEqual(getGuildPlayerSettings("guild"), {
      volume: 100,
      autoplay_enabled: false,
      dj_role_id: null,
    });
    setGuildStorageLimit("guild", 5000);
    updateGuildPlayerSettings("guild", {
      volume: 45,
      autoplay_enabled: true,
      dj_role_id: "123456789012345678",
    });
    assert.equal(getGuildStorageLimit("guild"), 5000);
    const { execute: autoplayCommand } = await import("../discord/commands/autoplay/command");
    const { MessageFlags } = await import("discord.js");
    const replies: unknown[] = [];
    const command = (id: string, dj = false) =>
      ({
        guildId: "command-guild",
        user: { id, username: id },
        memberPermissions: { has: () => false },
        guild: {
          members: {
            cache: new Map([
              [id, { roles: { cache: new Map(dj ? [["123456789012345678", {}]] : []) } }],
            ]),
          },
        },
        options: { getBoolean: () => null },
        deferReply: async (options: { flags: number }) => {
          assert.equal(options.flags, MessageFlags.Ephemeral);
        },
        editReply: async (message: unknown) => {
          replies.push(message);
        },
      }) as unknown as ChatInputCommandInteraction;
    await autoplayCommand(command("member"));
    assert.match(String(replies.pop()), /permission/);
    assert.equal(getGuildPlayerSettings("command-guild").autoplay_enabled, false);
    await autoplayCommand(command("258189484053495809"));
    assert.equal(getGuildPlayerSettings("command-guild").autoplay_enabled, true);
    updateGuildPlayerSettings("command-guild", { dj_role_id: "123456789012345678" });
    await autoplayCommand(command("dj", true));
    assert.equal(getGuildPlayerSettings("command-guild").autoplay_enabled, false);
    const track = (id: string): ProviderTrack => ({
      id,
      providerId: "youtube",
      title: id,
      url: `https://youtu.be/${id}`,
      channelName: "Artist",
      thumbnailUrl: "",
      length: 60,
      loudness: 0,
      playlistIdx: null,
    });
    let searches = 0;
    const provider: Provider = {
      id: "youtube",
      resolve: async () => null,
      getPlaylist: async () => null,
      getTrack: async (id) => track(id),
      getStream: async () => Readable.from(["audio"]),
      search: async () => {
        searches++;
        return track("radio");
      },
    };
    const player = new CorePlayer("guild", new Queue(), [provider]);
    assert.equal(player.volume, 45);
    player.setVolume(60, "owner");
    const reloaded = new CorePlayer("guild", new Queue(), [provider]);
    assert.equal(reloaded.volume, 60);
    assert.throws(() => player.setVolume(20.5, "owner"), /Volume/);
    assert.throws(() => updateGuildPlayerSettings("guild", { volume: 201 }), /Volume/);
    assert.throws(() => updateGuildPlayerSettings("guild", { dj_role_id: "../role" }), /role/);
    const played: string[] = [];
    player.onStream = (item, stream) => {
      played.push(item.id);
      stream.destroy();
    };
    player.enqueueTracks([track("seed")], "owner");
    await player.play();
    await player.finish();
    assert.deepEqual(played, ["seed", "radio"]);
    assert.equal(searches, 1);
    assert(
      getLatestEvents().some(
        (event) => event.action === "autoplay" && event.track_name === "radio",
      ),
    );
    await player.finish(); // same result is refused rather than played repeatedly
    assert.equal(player.isPlaying, false);
    assert.deepEqual(played, ["seed", "radio"]);
    await player.stop();
    player.enqueueTracks([track("failed")], "owner");
    const before = searches;
    await player.finish(true);
    assert.equal(searches, before, "Failed tracks must not generate an unbounded radio chain");
    await player.stop();
    updateGuildPlayerSettings("guild", { autoplay_enabled: false });
    player.enqueueTracks([track("disabled")], "owner");
    await player.finish();
    assert.equal(searches, before);
    await player.stop();
    updateGuildPlayerSettings("guild", { autoplay_enabled: true });
    let release!: (track: ProviderTrack) => void;
    provider.search = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    player.enqueueTracks([track("pending")], "owner");
    const pending = player.finish();
    await player.stop();
    release(track("late"));
    await pending;
    assert.equal(player.queue.tracks.length, 0, "Stop cancels an in-flight radio selection");
    assert.equal(player.isPlaying, false);
    player.enqueueTracks([track("one"), track("two"), track("three")], "owner");
    player.queue.currentIndex = 1;
    player.reorder(3, 1, "owner");
    assert.equal(player.queue.nowPlaying?.id, "two");
    assert.equal(player.queue.currentIndex, 2);
    assert.deepEqual(
      player.queue.tracks.map((item) => item.id),
      ["three", "one", "two"],
    );
    assert.throws(() => player.reorder(0, 1, "owner"), /position/);
    assert.equal(getGuildStorageLimit("guild"), 5000);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
