import type { Provider, ProviderTrack } from "@/providers";
import type { Client, VoiceState } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("sessions persist mutations, restore paused queues, clear on stop and survive deployment teardown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-persist-"));
  Object.assign(process.env, {
    TOKEN: "test-token",
    CLIENT_ID: "123456789012345678",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./db/client");
  try {
    const manager = await import("./manager");
    const { savedSessions, decodeSession } = await import("./db/session-state");
    const { userPlaylists } = await import("./db/user-playlists");
    const { restoreSessions } = await import("../discord/restore-sessions");
    const track = (id: string): ProviderTrack => ({
      id,
      providerId: "persist",
      title: id,
      url: "https://youtube.com/watch?v=x",
      channelName: "Artist",
      thumbnailUrl: "",
      length: 60,
      loudness: 1,
      playlistIdx: null,
    });
    const provider: Provider = {
      id: "persist",
      resolve: async () => null,
      getTrack: async () => null,
      getPlaylist: async () => null,
      getStream: async () => Readable.from(["audio"]),
    };
    manager.providers.push(provider);
    const { player } = manager.getOrCreateSession("guild");
    manager.setSessionChannels("guild", "voice", "text");
    player.enqueueTracks([track("first"), track("second")], "owner", false, false, "Owner");
    assert.equal(JSON.parse(savedSessions.all()[0].queue_json).length, 2);
    player.onStream = (_track, stream) => {
      stream.destroy();
    };
    player.onPause = () => true;
    await player.jump(1);
    player.toggleLoop();
    player.toggleLoop();
    assert.equal(player.pause("owner"), true);
    const row = savedSessions.all()[0];
    assert.equal(row.current_index, 1);
    assert.equal(row.loop_mode, "queue");
    assert.equal(row.is_paused, 1);
    assert.equal(decodeSession({ ...row, queue_json: "invalid" }), null);
    manager.deleteSession("guild", true);
    const voice = { id: "voice", guildId: "guild", isVoiceBased: () => true };
    const text = { id: "text", isVoiceBased: () => false, isTextBased: () => true };
    const guild = { channels: { fetch: async (id: string) => (id === "voice" ? voice : text) } };
    const client = { guilds: { cache: new Map([["guild", guild]]) } } as unknown as Client;
    let startsPaused = false;
    await restoreSessions(client, (_voice, _text, core) => {
      core.onStream = (_track, stream, _current, paused) => {
        startsPaused = paused;
        stream.destroy();
      };
      core.onPause = () => true;
    });
    const restored = manager.getSession("guild");
    assert(restored);
    assert.equal(restored.queue.nowPlaying?.id, "second");
    assert.equal(restored.queue.loopMode, "queue");
    assert.equal(restored.player.isPaused, true);
    assert.equal(startsPaused, true);
    assert.equal(restored.player.getState()?.progressSeconds, 0);
    await restored.player.remove(1, "owner");
    assert.equal(savedSessions.all()[0].current_index, 0);
    assert.equal(restored.queue.nowPlaying?.id, "second");

    const playlistId = userPlaylists.create("owner", "Chill Vibes", [
      track("first"),
      track("second"),
    ]);
    assert.equal(userPlaylists.byName("owner", "chill vibes")?.tracks[1].id, "second");
    assert.equal(userPlaylists.byName("other", "Chill Vibes"), undefined);
    assert.equal(userPlaylists.get("other", playlistId), undefined);
    assert.equal(userPlaylists.delete("other", playlistId), false);
    assert.throws(() => userPlaylists.create("owner", "CHILL VIBES"), /UNIQUE/);
    assert.equal(userPlaylists.delete("owner", playlistId), true);
    assert.equal(
      db.prepare<[], { count: number }>("SELECT count(*) AS count FROM UserPlaylistTrack").get()
        ?.count,
      0,
    );
    await restored.player.stop();
    assert.equal(savedSessions.all().length, 0);
    manager.deleteSession("guild");
    const { handleVoiceStateUpdate } = await import("../discord/client");
    const cleanup = manager.getOrCreateSession("cleanup");
    manager.setSessionChannels("cleanup", "voice", null);
    cleanup.player.enqueueTracks([track("cleanup")], "owner");
    const oldVoice = {
      id: "human",
      client: { user: { id: "bot" } },
      guild: { id: "cleanup" },
      channelId: "elsewhere",
      channel: { members: new Map([["other-human", {}]]) },
    } as unknown as VoiceState;
    await handleVoiceStateUpdate(oldVoice, { channelId: null } as VoiceState);
    assert.equal(
      savedSessions.all().length,
      1,
      "An unrelated channel change must not erase the queue",
    );
    await handleVoiceStateUpdate(
      { ...oldVoice, id: "bot", channelId: "voice" } as VoiceState,
      { channelId: null } as VoiceState,
    );
    assert.equal(savedSessions.all().length, 0, "The bot leaving voice deletes persistence");
    manager.deleteSession("cleanup");
    savedSessions.save({ ...row, queue_json: "invalid" });
    await restoreSessions(client, () => {
      throw new Error("Invalid rows must not connect");
    });
    assert.equal(savedSessions.all().length, 0);
    savedSessions.save(row);
    const unavailable = {
      guilds: {
        cache: new Map([
          [
            "guild",
            {
              channels: {
                fetch: async () => {
                  throw new Error("temporary outage");
                },
              },
            },
          ],
        ]),
      },
    } as unknown as Client;
    await restoreSessions(unavailable);
    assert.equal(
      savedSessions.all().length,
      1,
      "Transient Discord failures retain the saved queue",
    );
    await restoreSessions(
      client,
      (_voice, _text, core) => {
        core.onStream = async () => new Promise<void>(() => undefined);
      },
      5,
    );
    assert.equal(manager.getSession("guild"), undefined);
    assert.equal(savedSessions.all().length, 1, "Timed-out restoration retains the queue");
    const again = manager.hydrateSession(row);
    assert(again);
    manager.prepareSessionShutdown();
    manager.deleteSession("guild");
    assert.equal(savedSessions.all().length, 1, "Deployment teardown must not erase persistence");
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
