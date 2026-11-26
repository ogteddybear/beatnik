import SoundCloud from "@zibot/scdl";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { SoundCloudProvider } from "./index";

const id =
  "aHR0cHM6Ly9zb3VuZGNsb3VkLmNvbS9pbWthYnVraS9oYXBweS1rdXJ1LWt1cnUtaGFuYnVua28taGFuYWJpLWthYnVraS1yZW1peA";
const url = "https://soundcloud.com/imkabuki/happy-kuru-kuru-hanbunko-hanabi-kabuki-remix";

test("SoundCloud turns missing streams and download exceptions into a clean playback error", async (t) => {
  t.mock.method(SoundCloud.prototype, "init", async () => "test-client");
  const download = t.mock.method(
    SoundCloud.prototype,
    "downloadTrack",
    async (input: string): Promise<Readable | null | undefined> => {
      assert.equal(input, url);
      return undefined;
    },
  );
  const provider = new SoundCloudProvider();
  for (const missing of [undefined, null]) {
    download.mock.mockImplementation(async () => missing);
    await assert.rejects(provider.getStream(id), {
      name: "Error",
      message: "SoundCloud stream unavailable",
    });
  }
  download.mock.mockImplementation(async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'as')");
  });
  await assert.rejects(provider.getStream(id), {
    name: "Error",
    message: "SoundCloud stream unavailable",
  });
  const stream = Readable.from(["audio"]);
  download.mock.mockImplementation(async () => stream);
  assert.equal(await provider.getStream(id), stream);
  assert(download.mock.calls.every((call) => call.arguments[0] === url));
  stream.destroy();
});
