import type { ButtonInteraction } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("buttons enforce same-channel access, reject stale panels and route pause, skip and loop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-buttons-"));
  Object.assign(process.env, {
    TOKEN: "test-token",
    CLIENT_ID: "123456789012345678",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("../core/db/client");
  try {
    const { CorePlayer } = await import("../core/player");
    const { Queue } = await import("../core/queue");
    const { handlePlayerButton } = await import("./player-buttons");
    const queue = new Queue();
    queue.tracks = ["one", "two"].map((id) => ({
      id,
      providerId: "test",
      title: id,
      channelName: "Artist",
      thumbnailUrl: "",
      url: `https://example.com/${id}`,
      length: 60,
      loudness: 0,
      playlistIdx: null,
      addedBy: "requester",
    }));
    const player = new CorePlayer("guild", queue, []);
    player.isPlaying = true;
    player.onPause = () => true;
    let memberChannel = "other";
    let valid = true;
    let busy = false;
    let skips = 0;
    player.skip = async (id) => {
      assert.equal(id, "listener");
      skips++;
    };
    const session = {
      player,
      voice: {
        channelId: "voice",
        isCurrentMessage: (id: string) => valid && id === "current",
        runControl: async (action: () => Promise<void>) => {
          if (busy) return false;
          await action();
          return true;
        },
      },
    };
    const replies: string[] = [];
    let deferred = 0;
    const interaction = {
      customId: "player:pause",
      guildId: "guild",
      guild: { members: { fetch: async () => ({ voice: { channelId: memberChannel } }) } },
      client: { user: { id: "bot" } },
      message: { id: "current", author: { id: "bot" } },
      user: { id: "listener", username: "Listener" },
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
      },
      deferReply: async () => {
        deferred++;
      },
      editReply: async (content: string) => {
        replies.push(content);
      },
    };
    const click = () =>
      handlePlayerButton(interaction as unknown as ButtonInteraction, () => session);
    await click();
    assert.equal(player.isPaused, false);
    assert.match(replies.at(-1) ?? "", /Join Sashimi/);
    memberChannel = "voice";
    await click();
    assert.equal(player.isPaused, true);
    await click();
    assert.equal(player.isPaused, false);
    interaction.customId = "player:loop";
    await click();
    assert.equal(queue.loopMode, "track");
    await click();
    assert.equal(queue.loopMode, "queue");
    await click();
    assert.equal(queue.loopMode, "off");
    interaction.customId = "player:skip";
    await click();
    assert.equal(skips, 1);
    busy = true;
    await click();
    assert.equal(skips, 1);
    assert.match(replies.at(-1) ?? "", /Another player action/);
    busy = false;
    player.isLoading = true;
    await click();
    assert.equal(skips, 1);
    player.isLoading = false;
    valid = false;
    const acknowledgements = deferred;
    await click();
    assert.equal(skips, 1);
    assert.equal(deferred, acknowledgements);
    assert.match(replies.at(-1) ?? "", /no longer active/);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
