import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLiveStreamUrl } from "./resolve-url";
import { LIVE_STATIONS } from "./stations";

const stationUrl = LIVE_STATIONS.technobase.url;

test("resolves HTTP to HTTPS and relative redirects, cancelling every response body", async () => {
  const requests: string[] = [];
  let cancelled = 0;
  const fetcher: typeof fetch = async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.redirect, "manual");
    assert.equal(options?.method, "GET");
    const body = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    if (requests.length === 1)
      return new Response(body, {
        status: 302,
        headers: { location: "https://listener1.mp3.tb-group.fm/start" },
      });
    if (requests.length === 2)
      return new Response(body, {
        status: 307,
        headers: { location: "/tb.mp3" },
      });
    return new Response(body, { headers: { "content-type": "audio/mpeg" } });
  };
  assert.equal(
    await resolveLiveStreamUrl(stationUrl, { fetcher }),
    "https://listener1.mp3.tb-group.fm/tb.mp3",
  );
  assert.equal(requests.length, 3);
  assert.equal(cancelled, 3);
});

test("keeps an HTTP final URL when that is what the station advertises", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () =>
    ++requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "http://listener3.mp3.tb-group.fm:80/tb.mp3" },
        })
      : new Response(null);
  assert.equal(
    await resolveLiveStreamUrl(stationUrl, { fetcher }),
    "http://listener3.mp3.tb-group.fm/tb.mp3",
  );
});

test("rejects unapproved destinations before requesting them", async () => {
  for (const location of [
    "http://127.0.0.1/private",
    "http://listener1.mp3.tb-group.fm.evil.test/",
    "file:///etc/passwd",
    "https://user:password@listener1.mp3.tb-group.fm/",
    "https://listener1.mp3.tb-group.fm:8080/",
  ]) {
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location } });
    };
    await assert.rejects(resolveLiveStreamUrl(stationUrl, { fetcher }), /approved radio network/);
    assert.equal(requests, 1);
  }
});

test("redirect loops, excessive redirects, missing locations, and HTTP errors fail cleanly", async () => {
  await assert.rejects(
    resolveLiveStreamUrl(stationUrl, {
      fetcher: async () => new Response(null, { status: 302, headers: { location: stationUrl } }),
    }),
    /redirect loop/,
  );
  let requests = 0;
  await assert.rejects(
    resolveLiveStreamUrl(stationUrl, {
      fetcher: async () =>
        new Response(null, { status: 302, headers: { location: `/hop-${++requests}` } }),
    }),
    /Too many/,
  );
  assert.equal(requests, 6);
  await assert.rejects(
    resolveLiveStreamUrl(stationUrl, {
      fetcher: async () => new Response(null, { status: 302 }),
    }),
    /no destination/,
  );
  await assert.rejects(
    resolveLiveStreamUrl(stationUrl, {
      fetcher: async () => new Response(null, { status: 503 }),
    }),
    /HTTP 503/,
  );
});

test("a hung redirect lookup times out; manual cancellation also aborts it", async () => {
  const fetcher: typeof fetch = async (_input, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  await assert.rejects(resolveLiveStreamUrl(stationUrl, { fetcher, timeoutMs: 10 }), {
    name: "AbortError",
  });
  const controller = new AbortController();
  const pending = resolveLiveStreamUrl(stationUrl, { fetcher, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(
    resolveLiveStreamUrl("http://localhost/private", { fetcher }),
    /Unknown live station/,
  );
});
