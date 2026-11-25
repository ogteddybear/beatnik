import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("migrate flat caches to global and keep guild downloads isolated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-cache-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  try {
    const {
      migrateCacheNames,
      countCacheFiles,
      downloadToCache,
      getDownloadedIdStream,
      removeDownload,
    } = await import("./disk");
    await writeFile(path.join(directory, "legacy.cache"), "old cache");
    await writeFile(path.join(directory, "old.opus"), "old opus");
    await writeFile(path.join(directory, "sessions.db"), "session");
    await mkdir(path.join(directory, "guild-a"));
    await writeFile(path.join(directory, "guild-a", "present.cache"), "present");

    assert.equal(await migrateCacheNames(), 2);
    assert.equal(await migrateCacheNames(), 0);
    assert.equal(existsSync(path.join(directory, "legacy.cache")), false);
    assert.equal(
      await readFile(path.join(directory, "global", "legacy.cache"), "utf8"),
      "old cache",
    );
    assert.equal(await readFile(path.join(directory, "global", "old.cache"), "utf8"), "old opus");
    assert.equal(await countCacheFiles(), 3);

    assert.equal(await downloadToCache("guild-a", "legacy", Readable.from(["guild copy"])), true);
    assert.equal(await downloadToCache("guild-b", "new", Readable.from(["guild b"])), true);
    assert.equal(
      await readFile(path.join(directory, "guild-a", "legacy.cache"), "utf8"),
      "guild copy",
    );
    assert.equal(await readFile(path.join(directory, "guild-b", "new.cache"), "utf8"), "guild b");
    const stream = getDownloadedIdStream("guild-a", "legacy");
    assert(stream);
    let contents = "";
    for await (const chunk of stream) contents += chunk.toString();
    assert.equal(contents, "guild copy");
    await removeDownload("guild-a", "legacy");
    const fallback = getDownloadedIdStream("guild-a", "legacy");
    assert(fallback);
    contents = "";
    for await (const chunk of fallback) contents += chunk.toString();
    assert.equal(contents, "old cache");
    assert.equal(await countCacheFiles(), 4);
    assert.equal(getDownloadedIdStream("guild-b", "present"), undefined);
    assert.throws(() => getDownloadedIdStream("../outside", "legacy"), /Invalid guild ID/);
    assert.throws(() => getDownloadedIdStream("guild-a", "../outside"), /Invalid track ID/);

    await writeFile(path.join(directory, "legacy.cache"), "conflicting source");
    await assert.rejects(migrateCacheNames(), /destination already exists/);
    assert.equal(
      await readFile(path.join(directory, "global", "legacy.cache"), "utf8"),
      "old cache",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
