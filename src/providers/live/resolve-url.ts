import { LIVE_STATIONS, findLiveStation } from "./stations";

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
export async function resolveLiveStreamUrl(
  stationUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<string> {
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
      // GET follows the same path as FFmpeg. Never consume an endless audio body.
      const response = await fetcher(current.href, { method: "GET", redirect: "manual", signal });
      const location = response.headers.get("location");
      await response.body?.cancel();
      signal.throwIfAborted();
      if (redirectStatuses.has(response.status)) {
        if (!location) throw new Error("Live stream redirect has no destination.");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Live stream returned HTTP ${response.status}.`);
      return current.href;
    }
    throw new Error("Too many live stream redirects.");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
