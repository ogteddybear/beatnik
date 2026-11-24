import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SpotDl } from "spotdl-api";

import type { YoutubeProvider } from "../youtube";
import { SpotifyLinkResolver } from "./index";

test("playlist metadata timeout returns null without hanging", async () => {
  const resolver = SpotifyLinkResolver.createIfConfigured(
    {} as YoutubeProvider,
    async () => "test-token",
  );
  assert.ok(resolver);

  const save = mock.method(
    SpotDl.prototype,
    "save",
    async () =>
      new Promise<never>(() => {
        // Simulate an unresponsive spotdl process.
      }),
  );
  const info = mock.method(console, "info", () => undefined);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) =>
    realSetTimeout(callback, ms === 15_000 ? 1 : ms)) as typeof setTimeout;

  try {
    const result = await Promise.race([
      resolver.getPlaylist("spotify:playlist:example"),
      new Promise<never>((_, reject) =>
        realSetTimeout(() => reject(new Error("playlist resolution hung")), 200),
      ),
    ]);
    assert.equal(result, null);
    assert.equal(save.mock.callCount(), 1);
    assert.deepEqual(save.mock.calls[0].arguments[1]?.args, ["--use-official-api"]);
    assert.equal(save.mock.calls[0].arguments[1]?.signal?.aborted, true);
    assert.ok(info.mock.calls.some((call) => String(call.arguments[0]).includes("timed out")));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    save.mock.restore();
    info.mock.restore();
  }
});
