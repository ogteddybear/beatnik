import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { type LiveMetadata, stripIcyMetadata } from "./metadata";
import { LIVE_STATIONS, findLiveStation } from "./stations";

interface LiveRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  onMetadata?: (metadata: LiveMetadata | null) => void;
}

const stationHosts = new Set(Object.values(LIVE_STATIONS).map(({ url }) => new URL(url).hostname));
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function validateDestination(url: URL) {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443") ||
    (!stationHosts.has(url.hostname) && !/^listener\d+\.mp3\.tb-group\.fm$/.test(url.hostname))
  ) {
    throw new Error("Live stream redirected outside the approved radio network.");
  }
}

/** Resolve fresh on every attempt: the network may rotate its listener servers. */
async function requestLiveStream(stationUrl: string, options: LiveRequestOptions) {
  if (!findLiveStation(stationUrl)) throw new Error("Unknown live station.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const fetcher = options.fetcher ?? fetch;
  let current = new URL(stationUrl);
  const visited = new Set<string>();
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      validateDestination(current);
      if (visited.has(current.href)) throw new Error("Live stream redirect loop.");
      visited.add(current.href);
      // Resolve headers first; the caller either cancels or consumes the final body.
      const response = await fetcher(current.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "Icy-MetaData": "1" },
      });
      const location = response.headers.get("location");
      signal.throwIfAborted();
      if (redirectStatuses.has(response.status)) {
        await response.body?.cancel();
        if (!location) throw new Error("Live stream redirect has no destination.");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Live stream returned HTTP ${response.status}.`);
      }
      return { url: current.href, response, close: () => controller.abort() };
    }
    throw new Error("Too many live stream redirects.");
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveLiveStreamUrl(
  stationUrl: string,
  options: LiveRequestOptions = {},
): Promise<string> {
  const result = await requestLiveStream(stationUrl, options);
  try {
    await result.response.body?.cancel();
    return result.url;
  } finally {
    result.close();
  }
}

/** Node owns HTTP; FFmpeg receives MP3 bytes on stdin, never a network URL. */
export async function openLiveStream(stationUrl: string, options: LiveRequestOptions = {}) {
  const result = await requestLiveStream(stationUrl, options);
  if (!result.response.body) {
    result.close();
    throw new Error("Live stream returned an empty body.");
  }
  const stream = Readable.fromWeb(result.response.body as NodeReadableStream<Uint8Array>);
  // Guard the short handoff window before FFmpeg's pipeline installs listeners.
  stream.on("error", () => undefined);
  stream.once("close", result.close);
  return {
    url: result.url,
    stream: stripIcyMetadata(
      stream,
      result.response.headers.get("icy-metaint"),
      options.onMetadata,
    ),
  };
}
