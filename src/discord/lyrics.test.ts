import assert from "node:assert/strict";
import { test } from "node:test";

import { findLyrics, lyricsEmbed } from "./lyrics";

test("lyrics are cached, time bounded, and truncated after Markdown escaping", async () => {
  let requests = 0;
  const finder = async () => {
    requests++;
    return "**song**\n".repeat(1000);
  };
  const text = await findLyrics("Artist", "Song", finder);
  await findLyrics("Artist", "Song", finder);
  assert.equal(requests, 1);
  const embed = lyricsEmbed("Song", "Artist", text).toJSON();
  assert((embed.description?.length ?? 0) <= 4096);
  assert.match(embed.description ?? "", /Lyrics truncated/);
  assert.equal(embed.title, "Song");
  await assert.rejects(
    findLyrics("Other", "Timeout", async () => new Promise<string>(() => undefined), 5),
    /timeout/,
  );
  assert.match(lyricsEmbed("Empty", "", "").toJSON().description ?? "", /No lyrics found/);
});
