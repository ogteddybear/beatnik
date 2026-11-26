import type { ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("remove command uses the voice mutex and history responds with safe guild-scoped tracks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-queue-commands-"));
  Object.assign(process.env, {
    TOKEN: "test-token",
    CLIENT_ID: "123456789012345678",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("../../core/db/client");
  try {
    const { CorePlayer } = await import("../../core/player");
    const { Queue } = await import("../../core/queue");
    const { removeQueueWithInteraction } = await import("./remove/command");
    const history = await import("./history/command");
    const { logEvent } = await import("../../core/db/guild-events");
    const { builder: removeBuilder } = await import("./remove/builder");
    const { builder: libraryBuilder } = await import("./library/remove/builder");
    const { commandList } = await import("./index");
    const remove = await import("./remove/command");
    assert.equal(commandList.remove.execute, remove.execute);
    assert.equal(commandList.history.execute, history.execute);
    assert(commandList["library-remove"]);
    assert.equal(removeBuilder.toJSON().options?.[0].name, "position");
    assert.equal(libraryBuilder.name, "library-remove");
    const queue = new Queue();
    queue.tracks = ["current", "upcoming"].map((id) => ({
      id,
      providerId: "test",
      title: id,
      channelName: "Artist",
      thumbnailUrl: "",
      length: 60,
      url: "https://example.com/song",
      loudness: 1,
      playlistIdx: null,
      addedBy: "listener",
    }));
    const player = new CorePlayer("guild", queue, []);
    let channel = "other";
    let busy = false;
    let locks = 0;
    const session = {
      player,
      voice: {
        channelId: "voice",
        isCurrentMessage: () => true,
        runControl: async (action: () => Promise<void>) => {
          locks++;
          if (busy) return false;
          await action();
          return true;
        },
      },
    };
    const replies: string[] = [];
    const interaction = {
      guildId: "guild",
      guild: {
        members: {
          cache: new Map([
            [
              "listener",
              {
                voice: {
                  get channel() {
                    return { id: channel };
                  },
                },
              },
            ],
          ]),
          me: { voice: { channelId: "voice" } },
        },
      },
      user: { id: "listener", username: "Listener" },
      deferReply: async () => undefined,
      editReply: async (content: string) => {
        replies.push(content);
      },
    } as unknown as ChatInputCommandInteraction;
    await removeQueueWithInteraction(interaction, 2, () => session);
    assert.equal(queue.tracks.length, 2);
    assert.equal(locks, 0);
    channel = "voice";
    busy = true;
    await removeQueueWithInteraction(interaction, 2, () => session);
    assert.equal(queue.tracks.length, 2);
    assert.match(replies.at(-1) ?? "", /Another player action/);
    busy = false;
    await removeQueueWithInteraction(interaction, 10, () => session);
    assert.match(replies.at(-1) ?? "", /between 1 and 2/);
    await removeQueueWithInteraction(interaction, 2, () => session);
    assert.deepEqual(
      queue.tracks.map((item) => item.id),
      ["current"],
    );
    assert.match(replies.at(-1) ?? "", /Removed.*upcoming/);
    logEvent({
      guildId: "guild",
      eventType: "player",
      action: "play",
      trackName: "**Track** @everyone",
    });
    logEvent({ guildId: "other", eventType: "player", action: "play", trackName: "Private song" });
    let response: unknown;
    await history.execute({
      guildId: "guild",
      reply: async (payload: unknown) => {
        response = payload;
      },
    } as unknown as ChatInputCommandInteraction);
    const serialized = JSON.stringify(response);
    assert.match(serialized, /Track/);
    assert.doesNotMatch(serialized, /Private song/);
    assert.match(serialized, /"parse":\[\]/);
    assert.match(serialized, /Recently played/);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
