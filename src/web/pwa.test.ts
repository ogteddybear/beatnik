import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("service worker never caches APIs or private navigation responses", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const writes: string[] = [];
  runInNewContext(await readFile("src/web/public/sw.js", "utf8"), {
    URL,
    self: {
      location: { origin: "https://sashimi.example" },
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        handlers.set(name, callback),
    },
    fetch: async () => new Response("private dashboard"),
    caches: {
      open: async () => ({
        put: async (request: { url: string }) => {
          writes.push(request.url);
        },
      }),
    },
  });
  const handle = handlers.get("fetch");
  assert(handle);
  let intercepted = 0;
  let result: Promise<Response> | undefined;
  const event = (path: string, mode: string) => ({
    request: { url: `https://sashimi.example${path}`, method: "GET", mode },
    respondWith: (response: Promise<Response>) => {
      intercepted++;
      result = response;
    },
    waitUntil: (_promise: Promise<unknown>) => {
      /* Keep test assets in memory only. */
    },
  });
  handle(event("/api/events/stream", "cors"));
  handle(event("/api/playlists", "cors"));
  assert.equal(intercepted, 0);
  handle(event("/dashboard", "navigate"));
  assert(result);
  assert.equal(await (await result).text(), "private dashboard");
  assert.equal(writes.length, 0);
  handle(event("/static/theme.js", "cors"));
  assert(result);
  await result;
  assert.deepEqual(writes, ["https://sashimi.example/static/theme.js"]);
});
