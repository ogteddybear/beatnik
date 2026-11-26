import assert from "node:assert/strict";
import { test } from "node:test";

import { Queue, type QueuedTrack } from "./queue";

const track = (id: string): QueuedTrack => ({
  id,
  providerId: "test",
  title: id,
  channelName: "Artist",
  thumbnailUrl: "",
  url: `https://example.com/${id}`,
  length: 60,
  loudness: 0,
  playlistIdx: null,
  addedBy: "user",
});

test("queue cycles loop modes and only repeats a track on natural completion", () => {
  const queue = new Queue();
  queue.tracks = ["one", "two"].map(track);
  assert.equal(queue.loopMode, "off");
  assert.equal(queue.toggleLoop(), "track");
  assert.equal(queue.advance(), true);
  assert.equal(queue.currentIndex, 0);
  queue.advance(false);
  assert.equal(queue.nowPlaying?.id, "two");
  assert.equal(queue.toggleLoop(), "queue");
  queue.advance();
  assert.equal(queue.nowPlaying?.id, "one");
  assert.deepEqual(
    queue.upcoming().map((item) => item.id),
    ["two", "one"],
  );
  assert.equal(queue.toggleLoop(), "off");
  queue.advance();
  assert.equal(queue.advance(), false);
});

test("queue keeps every upcoming track when shuffled and bounds previews", () => {
  const queue = new Queue();
  queue.tracks = Array.from({ length: 8 }, (_, index) => track(String(index)));
  queue.shuffle();
  assert.equal(queue.nowPlaying?.id, "0");
  assert.deepEqual(queue.tracks.map((item) => item.id).sort(), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  assert.equal(queue.upcoming().length, 5);
  const empty = new Queue();
  empty.loopMode = "queue";
  assert.equal(empty.advance(), false);
});
