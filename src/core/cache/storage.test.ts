import type { Provider } from "@/providers";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("guild quotas bound unknown-size and concurrent writes and preserve streaming fallback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-quota-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const { db, archiveDb } = await import("../db/client");
  try {
    const { getGuildStorageLimit, setGuildStorageLimit } = await import("../db/guild-settings");
    const { calculateGuildStorage, guildStorageSummary } = await import("./storage");
    const { downloadToCache, getDownloadedIdStream } = await import("./disk");
    const { getLatestEvents } = await import("../db/guild-events");
    const { storageEmbed } = await import("../../discord/commands/storage/command");
    assert.equal(getGuildStorageLimit("a"), 104857600);
    assert.equal(await calculateGuildStorage("missing"), 0);
    await assert.rejects(calculateGuildStorage("../bad"), /Invalid guild ID/);
    await mkdir(path.join(directory, "global"));
    await writeFile(path.join(directory, "global", "shared.cache"), "shared audio");
    setGuildStorageLimit("a", 10);
    assert.equal(await downloadToCache("a", "fits", Readable.from(["12345", "67890"])), true);
    assert.equal(await calculateGuildStorage("a"), 10);
    assert.equal(await downloadToCache("a", "full", Readable.from(["x"])), false);
    assert.equal(await calculateGuildStorage("a"), 10);
    setGuildStorageLimit("b", 10);
    assert.equal(
      await downloadToCache("b", "large", Readable.from(["123456", "78901"]), undefined, {
        userId: "1",
        username: "Listener",
        trackName: "Too big",
      }),
      false,
    );
    assert.deepEqual(
      await readdir(path.join(directory, "b")),
      [],
      "No partial or final file remains",
    );
    const event = getLatestEvents().find((entry) => entry.guild_id === "b");
    assert.equal(event?.action, "quota_exceeded");
    assert.equal(event?.track_name, "Too big");
    assert.equal(event?.username, "Listener");
    assert.equal(JSON.parse(event?.metadata ?? "{}").trackId, "large");
    const writes = await Promise.all(
      ["one", "two"].map((id) => downloadToCache("b", id, Readable.from(["123456"]))),
    );
    assert.equal(writes.filter(Boolean).length, 1);
    assert.equal(await calculateGuildStorage("b"), 6);
    // Failed input must also remove its partially written file.
    async function* broken() {
      yield Buffer.from("x");
      throw new Error("input failed");
    }
    assert.equal(await downloadToCache("b", "broken", Readable.from(broken())), false);
    assert.equal(existsSync(path.join(directory, "b", "broken.cache")), false);
    assert.equal(await calculateGuildStorage("b"), 6);
    setGuildStorageLimit("a", 1);
    assert.equal((await guildStorageSummary("a")).storagePercentage, 1000);
    assert.equal((await guildStorageSummary("a")).storageOverQuota, true);
    assert(
      existsSync(path.join(directory, "a", "fits.cache")),
      "Lowering quota does not evict audio",
    );
    setGuildStorageLimit("b", 0);
    assert.equal(await downloadToCache("b", "zero", Readable.from(["x"])), false);
    assert.equal(
      getDownloadedIdStream("b", "uncached"),
      undefined,
      "Cache miss permits provider resolution",
    );
    const { resolveStream } = await import("../resolvers");
    const provider: Provider = {
      id: "quota-test",
      resolve: async () => null,
      getTrack: async () => null,
      getPlaylist: async () => null,
      getStream: async () => Readable.from(["streamed audio"]),
    };
    const playback = await resolveStream("b", "large", provider);
    assert.equal(playback.fromCache, false);
    let audio = "";
    for await (const chunk of playback.stream) audio += chunk.toString();
    assert.equal(audio, "streamed audio", "Quota rejection does not block provider playback");
    const shared = getDownloadedIdStream("b", "shared");
    assert(shared, "Shared legacy fallback remains available");
    shared.destroy();
    assert.equal(
      storageEmbed(60 * 1048576, 100 * 1048576).toJSON().description,
      "`[██████░░░░]` 60% (60.0 MB / 100.0 MB)",
    );
    assert.equal(storageEmbed(95, 100).toJSON().color, 0xffc107);
    assert.equal(storageEmbed(101, 100).toJSON().color, 0xdc3545);
    assert.match(storageEmbed(1000, 100).toJSON().description ?? "", /\[██████████\].*1000%/);
    assert.match(storageEmbed(0, 0).toJSON().description ?? "", /0%/);
    assert.doesNotMatch(storageEmbed(1, 0).toJSON().description ?? "", /Infinity|NaN/);
    assert.throws(() => setGuildStorageLimit("a", -1), /Invalid/);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
