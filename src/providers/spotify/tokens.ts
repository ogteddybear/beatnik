import { spotifyUsers } from "@/core/db/spotify-users";

export function spotifyClientConfig() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}
const pending = new Map<string, Promise<string | null>>();
export async function getValidSpotifyAccessToken(discordUserId: string): Promise<string | null> {
  const row = spotifyUsers.get(discordUserId);
  if (!row) return null;
  if (row.expires_at > Date.now() + 30_000) return row.access_token;
  const existing = pending.get(discordUserId);
  if (existing) return existing;
  const task = (async () => {
    const config = spotifyClientConfig();
    if (!config) return null;
    try {
      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.id}:${config.secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: row.refresh_token,
        }),
      });
      if (!response.ok) {
        if (response.status === 400) {
          const error = (await response.json()) as { error?: string };
          if (error.error === "invalid_grant") spotifyUsers.revoke(row);
        }
        return null;
      }
      const body = (await response.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.expires_in !== "number" ||
        !Number.isFinite(body.expires_in) ||
        body.expires_in <= 0
      )
        return null;
      const refresh =
        typeof body.refresh_token === "string" && body.refresh_token
          ? body.refresh_token
          : row.refresh_token;
      const expires = Date.now() + body.expires_in * 1000;
      if (!Number.isSafeInteger(expires)) return null;
      return spotifyUsers.refresh(row, body.access_token, refresh, expires)
        ? body.access_token
        : null;
    } catch {
      return null;
    } // Never log token responses, headers or raw fetch errors.
  })();
  pending.set(discordUserId, task);
  try {
    return await task;
  } finally {
    if (pending.get(discordUserId) === task) pending.delete(discordUserId);
  }
}
