import { spotifyUsers } from "@/core/db/spotify-users";

import { SpotifyApiError } from "./errors";
import { getValidSpotifyAccessToken } from "./tokens";

export { SPOTIFY_LINK_MESSAGE, SpotifyApiError, SpotifyPlaylistUnavailableError } from "./errors";
export async function spotifyUserRequest<T>(
  id: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const url = new URL(path, "https://api.spotify.com/v1/");
    if (url.origin !== "https://api.spotify.com" || !url.pathname.startsWith("/v1/"))
      throw new SpotifyApiError(400);
    let token = await getValidSpotifyAccessToken(id);
    if (!token) throw new SpotifyApiError(401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      });
      if (response.status === 401 && attempt === 0) {
        spotifyUsers.expire(id, token);
        token = await getValidSpotifyAccessToken(id);
        if (!token) throw new SpotifyApiError(401);
        continue;
      }
      if (!response.ok) throw new SpotifyApiError(response.status);
      return (await response.json()) as T;
    }
    throw new SpotifyApiError(401);
  } catch (error) {
    if (error instanceof SpotifyApiError) throw error;
    throw new SpotifyApiError(503);
  }
}
export interface UserSpotifyPlaylist {
  id: string;
  name: string;
  owner?: { display_name?: string };
  tracks?: { total?: number };
  items?: { total?: number };
}
export async function getUserSpotifyPlaylists(
  id: string,
  page = 1,
  limit = 10,
  signal?: AbortSignal,
) {
  const safePage = Math.max(1, Math.min(1000, Math.floor(page)));
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const data = await spotifyUserRequest<{
    items?: UserSpotifyPlaylist[];
    total?: number;
    next?: string | null;
  }>(id, `me/playlists?limit=${safeLimit}&offset=${(safePage - 1) * safeLimit}`, signal);
  return {
    items: (data.items ?? []).filter(
      (item) => item && /^[A-Za-z0-9]+$/.test(item.id) && typeof item.name === "string",
    ),
    total: data.total ?? 0,
    page: safePage,
    hasNext: !!data.next,
  };
}
