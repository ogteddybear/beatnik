import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";

import { type LiveMetadata, parseLiveMetadata, stripIcyMetadata } from "./metadata";

function block(audio: Buffer, metadata: string) {
  const bytes = Buffer.from(metadata);
  const size = Math.ceil(bytes.length / 16);
  const padded = Buffer.alloc(size * 16);
  bytes.copy(padded);
  return Buffer.concat([audio, Buffer.from([size]), padded]);
}

test("ICY parsing removes interleaved metadata across fragmented UTF-8 boundaries", async () => {
  const first = Buffer.from("12345678");
  const second = Buffer.from("abcdefgh");
  const third = Buffer.from("ABCDEFGH");
  const body = Buffer.concat([
    block(first, "StreamTitle='Düo - Tïtle';"),
    block(second, ""),
    block(third, "StreamTitle='';"),
  ]);
  const updates: (LiveMetadata | null)[] = [];
  const source = Readable.from([...body].map((byte) => Buffer.from([byte])));
  const output = stripIcyMetadata(source, "8", (value) => updates.push(value));
  const chunks: Buffer[] = [];
  for await (const chunk of output) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, second, third]));
  assert.deepEqual(updates, [{ streamTitle: "Düo - Tïtle", artist: "Düo", title: "Tïtle" }, null]);
});

test("plain MP3 bypasses metadata detection without buffering or rewriting audio", async () => {
  for (const header of [null, "", "bad", "-1", "0", "1.5", "999999999999999999"]) {
    const source = Readable.from([Buffer.from("plain MP3")]);
    assert.equal(stripIcyMetadata(source, header), source);
    source.destroy();
  }
});

test("closing ICY output before consumption tears down the upstream stream", async () => {
  const source = new PassThrough();
  const output = stripIcyMetadata(source, "8");
  const closed = once(source, "close");
  output.destroy();
  await closed;
  assert.equal(source.destroyed, true);
});

test("ICY source failures propagate to the audio output", async () => {
  const source = new PassThrough();
  const output = stripIcyMetadata(source, "8");
  const failed = once(output, "error");
  source.destroy(new Error("radio disconnected"));
  const [error] = await failed;
  assert.match(error.message, /radio disconnected/);
});

test("metadata preserves ambiguous titles, removes controls, and bounds remote strings", () => {
  assert.deepEqual(parseLiveMetadata("Live DJ set"), {
    streamTitle: "Live DJ set",
    title: "Live DJ set",
  });
  assert.equal(parseLiveMetadata("\u0000 \r\n"), null);
  assert.equal(parseLiveMetadata("A".repeat(900))?.streamTitle.length, 512);
  assert.equal(parseLiveMetadata("Artist - Title - Remix")?.title, "Title - Remix");
});
