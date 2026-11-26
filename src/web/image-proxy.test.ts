import express from "express";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { ClientRequest } from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { test } from "node:test";

import { proxyImageUrl } from "../utils/image-proxy";
import {
  decodeImageUrl,
  downloadImage,
  isPublicImageAddress,
  mountImageProxy,
  readImage,
  resolveImageAddress,
} from "./image-proxy";

test("image proxy rejects private/reserved IPs, mapped IPv6 and malformed URL encodings", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
    "192.0.2.1",
  ])
    assert.equal(isPublicImageAddress(ip), false, ip);
  assert.equal(isPublicImageAddress("8.8.8.8"), true);
  await assert.rejects(
    resolveImageAddress("i.ytimg.com", async () => [{ address: "127.0.0.1", family: 4 }]),
    { status: 403 },
  );
  const encoded = (url: string) => Buffer.from(url).toString("base64url");
  for (const input of [
    "%",
    "a",
    "***",
    "",
    ["bad"],
    encoded("not a URL"),
    encoded("https://127.0.0.1/image.png"),
    encoded("https://evil.example/a.png"),
    encoded("http://i.ytimg.com/a.png"),
    encoded("https://i.ytimg.com:444/a.png"),
    encoded("https://i.ytimg.com/../a.png"),
    encoded("https://i.ytimg.com/%2e%2e/a.png"),
    encoded("https://i.ytimg.com/%0d%0aX-Test:evil"),
    encoded("https://i.ytimg.com@evil.example/a.png"),
    encoded("https://i.ytimg.com/a.png#fragment"),
  ])
    assert.throws(() => decodeImageUrl(input), { status: 400 });
  const url = "https://i.ytimg.com/vi/video/hqdefault.jpg";
  assert.equal(decodeImageUrl(encoded(url)).href, url);
  for (const host of [
    "e-cdns-images.dzcdn.net",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "i3.sndcdn.com",
    "i4.sndcdn.com",
  ]) {
    const image = `https://${host}/image.jpg`;
    assert.equal(decodeImageUrl(encoded(image)).href, image);
    assert.throws(() => decodeImageUrl(encoded(`https://${host}.evil.example/image.jpg`)), {
      status: 400,
    });
  }
  assert.equal(proxyImageUrl(proxyImageUrl(url)), proxyImageUrl(url));
});

test("image proxy rejects HTML/SVG, mislabeled content, redirects and oversized streaming bodies", async () => {
  const response = (chunks: Buffer[], type: string, length?: string, status = 200) =>
    Object.assign(Readable.from(chunks), {
      statusCode: status,
      headers: { "content-type": type, ...(length ? { "content-length": length } : {}) },
    }) as unknown as IncomingMessage;
  await assert.rejects(readImage(response([Buffer.from("<html>")], "text/html")), { status: 403 });
  await assert.rejects(readImage(response([Buffer.from("<svg>")], "image/svg+xml")), {
    status: 403,
  });
  await assert.rejects(readImage(response([Buffer.from("<html>")], "image/png")), { status: 403 });
  await assert.rejects(readImage(response([], "image/png", undefined, 302)), { status: 403 });
  await assert.rejects(readImage(response([], "image/png", String(5 * 1024 * 1024 + 1))), {
    status: 413,
  });
  await assert.rejects(
    readImage(
      response([Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024)], "image/png"),
    ),
    { status: 413 },
  );
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual((await readImage(response([png], "image/png"))).buffer, png);
});

test("image proxy caches validated images and responds with safe browser headers", async () => {
  const app = express();
  let calls = 0;
  mountImageProxy(app, async () => {
    calls++;
    return { buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), type: "image/png" };
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(origin + "/api/image-proxy/!bad")).status, 400);
    const path = new URL(proxyImageUrl("https://i.ytimg.com/image.png")).pathname;
    const first = await fetch(origin + path);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.equal(first.headers.get("content-disposition"), "inline");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.equal(first.headers.get("cache-control"), "public, max-age=3600");
    await first.arrayBuffer();
    await (await fetch(origin + path)).arrayBuffer();
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("native HTTPS lookup pins the validated address while retaining the CDN TLS hostname", async (t) => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let pinned = false;
  t.mock.method(https, "get", ((
    url: URL,
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    assert.equal(url.hostname, "i.ytimg.com");
    assert.equal(options.agent, false);
    assert.equal(options.family, 4);
    assert(options.lookup);
    options.lookup("i.ytimg.com", {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
      pinned = true;
    });
    const response = Object.assign(Readable.from([png]), {
      statusCode: 200,
      headers: { "content-type": "image/png" },
    }) as unknown as IncomingMessage;
    queueMicrotask(() => callback(response));
    return Object.assign(new EventEmitter(), {
      setTimeout: () => undefined,
    }) as unknown as ClientRequest;
  }) as typeof https.get);
  const result = await downloadImage(
    new URL("https://i.ytimg.com/image.png"),
    new AbortController().signal,
    async () => ({ address: "8.8.8.8", family: 4 }),
  );
  assert(pinned);
  assert.deepEqual(result.buffer, png);
});
