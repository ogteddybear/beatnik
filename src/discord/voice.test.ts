import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("voice lifecycle records one real join and leave, not reconnect duplicates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-voice-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const { db, archiveDb } = await import("../core/db/client");
  try {
    const { trackVoiceLifecycle } = await import("./voice");
    const { getLatestEvents } = await import("../core/db/guild-events");
    const connection = new EventEmitter();
    trackVoiceLifecycle(
      connection,
      "guild",
      { id: "channel", name: "Listening room" },
      { userId: "1", username: "Listener" },
    );
    connection.emit("ready");
    connection.emit("ready");
    connection.emit("destroyed");
    connection.emit("destroyed");
    const events = getLatestEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1].action, "join");
    assert.equal(events[1].username, "Listener");
    assert.equal(events[0].action, "leave");
    assert.equal(events[0].user_id, null, "Automatic leave isn't attributed to the requester");
    assert.equal(JSON.parse(events[0].metadata ?? "{}").channelName, "Listening room");
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
