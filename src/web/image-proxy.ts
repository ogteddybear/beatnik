import { LIVE_STATIONS } from "@/providers/live/stations";
import type { Express } from "express";
import ipaddr from "ipaddr.js";
import { LRUCache } from "lru-cache";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";

const RADIO_IMAGES = new Set<string>(
  Object.values(LIVE_STATIONS).map((station) => station.artworkUrl),
);
const HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "i.ytimg.com",
  "img.youtube.com",
  "i.scdn.co",
  "mosaic.scdn.co",
  "i1.sndcdn.com",
  "i2.sndcdn.com",
  "i3.sndcdn.com",
  "i4.sndcdn.com",
  "e-cdns-images.dzcdn.net",
  "yt3.ggpht.com",
  "yt3.googleusercontent.com",
]);
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE = 5 * 1024 * 1024;
export class ImageProxyError extends Error {
  constructor(public readonly status: number) {
    super("Image unavailable");
  }
}
export function validateImageUrl(raw: string): URL {
  try {
    const decoded = decodeURIComponent(raw);
    if (
      [...raw].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "\\") ||
      [...decoded].some((c) => c.charCodeAt(0) < 32 || c === "\\") ||
      decoded.includes("../") ||
      decoded.includes("/..") ||
      /%25/i.test(raw)
    )
      throw new Error("Unsafe URL");
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      (!HOSTS.has(url.hostname) && !RADIO_IMAGES.has(url.href)) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw new Error("Forbidden URL");
    return url;
  } catch {
    throw new ImageProxyError(400);
  }
}
export function decodeImageUrl(encoded: unknown): URL {
  try {
    if (
      typeof encoded !== "string" ||
      !encoded ||
      encoded.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    )
      throw new Error("Invalid encoding");
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("Noncanonical encoding");
    return validateImageUrl(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImageProxyError(400);
  }
}
export function isPublicImageAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function resolveImageAddress(
  host: string,
  resolver = (hostname: string) => lookup(hostname, { all: true, verbatim: true }),
) {
  const addresses = await resolver(host);
  if (!addresses.length || addresses.some((result) => !isPublicImageAddress(result.address)))
    throw new ImageProxyError(403);
  return addresses[0];
}
export async function readImage(response: IncomingMessage) {
  const type = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (
    response.statusCode !== 200 ||
    !type ||
    !TYPES.has(type) ||
    (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
  ) {
    response.destroy();
    throw new ImageProxyError(403);
  }
  const length = response.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE)) {
    response.destroy();
    throw new ImageProxyError(413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_IMAGE) {
      response.destroy();
      throw new ImageProxyError(413);
    }
    chunks.push(buffer);
  }
  if (!size || (length !== undefined && Number(length) !== size)) throw new ImageProxyError(502);
  const buffer = Buffer.concat(chunks, size);
  // Verify raster signatures as well as the upstream header; never serve HTML labeled as an image.
  const valid =
    type === "image/jpeg"
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : type === "image/png"
        ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : type === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
          : buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
            buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new ImageProxyError(403);
  return { buffer, type };
}
export async function downloadImage(
  url: URL,
  signal: AbortSignal,
  resolver = (hostname: string) => resolveImageAddress(hostname),
) {
  const address = await resolver(url.hostname);
  signal.throwIfAborted();
  return new Promise<Awaited<ReturnType<typeof readImage>>>((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: false,
        family: address.family,
        // URL hostname remains intact for TLS certificate verification/SNI and Host.
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        signal,
        maxHeaderSize: 8192,
        headers: {
          Accept: "image/jpeg,image/png,image/webp,image/gif",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        void readImage(response).then(resolve, reject);
      },
    );
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new ImageProxyError(504)));
  });
}
export function mountImageProxy(app: Express, downloader = downloadImage) {
  const cache = new LRUCache<string, Awaited<ReturnType<typeof readImage>>>({
    max: 2000,
    maxSize: 250 * 1024 * 1024,
    ttl: 86400000,
    sizeCalculation: (value, key) => value.buffer.length + Buffer.byteLength(key) + 256,
  });
  const pending = new Map<string, Promise<Awaited<ReturnType<typeof readImage>>>>();
  app.get("/api/image-proxy/:url", async (req, res) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "no-store",
    });
    try {
      const url = decodeImageUrl(req.params.url);
      const key = url.href;
      let image = cache.get(key);
      if (!image) {
        let task = pending.get(key);
        if (!task) {
          if (pending.size >= 4) return res.sendStatus(503);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          task = Promise.race([
            downloader(url, controller.signal),
            new Promise<never>((_resolve, reject) =>
              controller.signal.addEventListener("abort", () => reject(new ImageProxyError(504)), {
                once: true,
              }),
            ),
          ])
            .then((value) => {
              cache.set(key, value);
              return value;
            })
            .finally(() => {
              clearTimeout(timer);
              pending.delete(key);
            });
          pending.set(key, task);
        }
        image = await task;
      }
      res.set({
        "Content-Type": image.type,
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=3600",
      });
      return res.send(image.buffer);
    } catch (error) {
      return res.sendStatus(error instanceof ImageProxyError ? error.status : 502);
    }
  });
}
