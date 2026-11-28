import { tidalUsers } from "@/core/db/tidal-users";

import { TidalApiError, TidalNotLinkedError } from "./errors";
import { getValidTidalAccessToken } from "./tokens";

const BASE = "https://openapi.tidal.com/v2/";
interface Resource {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    title?: string;
    numberOfTrackItems?: number;
    numberOfItems?: number;
    duration?: string;
  };
  relationships?: { artists?: { data?: { type: string; id: string }[] } };
}
type Link = string | { href: string } | null;
interface Document {
  data: Resource[];
  included?: Resource[];
  links?: { next?: Link };
}
export interface TidalPlaylist {
  id: string;
  name: string;
  trackCount: number;
}
export interface TidalTrack {
  trackId: string;
  title: string;
  artist: string;
  duration: number;
}

function trustedUrl(value: string, base = BASE) {
  const url = new URL(value, base);
  if (
    url.origin !== new URL(BASE).origin ||
    !url.pathname.startsWith("/v2/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TidalApiError(502);
  const country = process.env.TIDAL_COUNTRY_CODE || "US";
  if (!/^[A-Z]{2}$/.test(country)) throw new TidalApiError(503);
  url.searchParams.set("countryCode", country);
  return url;
}

async function request(userId: string, url: URL, signal: AbortSignal): Promise<Document> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getValidTidalAccessToken(userId);
    if (!token) throw new TidalNotLinkedError();
    const row = tidalUsers.get(userId);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (response.status === 401) {
      if (attempt === 0) {
        tidalUsers.expire(userId, token);
        continue;
      }
      if (row?.access_token === token) tidalUsers.revoke(row);
      throw new TidalNotLinkedError();
    }
    if (!response.ok) throw new TidalApiError(response.status);
    const body = (await response.json()) as Document;
    if (
      !body ||
      !Array.isArray(body.data) ||
      body.data.some(
        (item) => !item || typeof item.id !== "string" || typeof item.type !== "string",
      ) ||
      (body.included !== undefined && !Array.isArray(body.included))
    )
      throw new TidalApiError(502);
    return body;
  }
  throw new TidalNotLinkedError();
}

async function* pages(userId: string, path: string, signal: AbortSignal) {
  let next: URL | null = trustedUrl(path);
  const seen = new Set<string>();
  while (next) {
    signal.throwIfAborted();
    if (seen.has(next.href)) throw new TidalApiError(502);
    seen.add(next.href);
    const body = await request(userId, next, signal);
    yield body;
    const link: Link | undefined = body.links?.next;
    const href = typeof link === "string" ? link : link?.href;
    next = href ? trustedUrl(href, next.href) : null;
  }
}

/** Follow every cursor page; only send bearer credentials to the trusted Tidal API. */
export async function getUserPlaylists(
  discordUserId: string,
  signal = AbortSignal.timeout(60_000),
): Promise<TidalPlaylist[]> {
  const playlists: TidalPlaylist[] = [];
  for await (const page of pages(discordUserId, "playlists?filter[owners.id]=me", signal)) {
    for (const item of page.data) {
      if (item.type !== "playlists") continue;
      playlists.push({
        id: item.id,
        name: item.attributes?.name || "Untitled playlist",
        trackCount: item.attributes?.numberOfTrackItems ?? item.attributes?.numberOfItems ?? 0,
      });
    }
  }
  return playlists;
}

function durationSeconds(value: string | undefined) {
  const match = value?.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  return match
    ? Number(match[1] || 0) * 86400 +
        Number(match[2] || 0) * 3600 +
        Number(match[3] || 0) * 60 +
        Number(match[4] || 0)
    : 0;
}

export async function getPlaylistTracks(
  discordUserId: string,
  playlistId: string,
  signal = AbortSignal.timeout(60_000),
): Promise<TidalTrack[]> {
  if (!playlistId || playlistId.length > 256) throw new TidalApiError(400);
  const tracks: TidalTrack[] = [];
  const path = `playlists/${encodeURIComponent(playlistId)}/relationships/items?include=items,items.tracks:artists`;
  for await (const page of pages(discordUserId, path, signal)) {
    const included = new Map(
      (page.included || []).map((item) => [`${item.type}:${item.id}`, item]),
    );
    for (const item of page.data) {
      if (item.type !== "tracks") continue;
      const track = included.get(`tracks:${item.id}`) || item;
      if (!track.attributes?.title) continue; // Unavailable/redacted item, not a playable track.
      const artist = (track.relationships?.artists?.data || [])
        .map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.name)
        .filter(Boolean)
        .join(", ");
      tracks.push({
        trackId: track.id,
        title: track.attributes.title,
        artist,
        duration: durationSeconds(track.attributes.duration),
      });
    }
  }
  return tracks;
}
