import { db } from "./client";

export interface SpotifyUserTokens {
  discord_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  spotify_user_id: string | null;
  spotify_display_name: string | null;
  updated_at: number;
}
const save = (row: SpotifyUserTokens) =>
  db
    .prepare(
      `INSERT INTO SpotifyUserTokens
  (discord_user_id, access_token, refresh_token, expires_at, spotify_user_id, spotify_display_name, updated_at)
  VALUES (@discord_user_id, @access_token, @refresh_token, @expires_at, @spotify_user_id, @spotify_display_name, @updated_at)
  ON CONFLICT(discord_user_id) DO UPDATE SET access_token=excluded.access_token,
  refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
  spotify_user_id=excluded.spotify_user_id, spotify_display_name=excluded.spotify_display_name, updated_at=excluded.updated_at`,
    )
    .run(row);

export const spotifyUsers = {
  get: (id: string) =>
    db
      .prepare<[string], SpotifyUserTokens>(
        "SELECT * FROM SpotifyUserTokens WHERE discord_user_id = ?",
      )
      .get(id),
  summary(id: string) {
    const row = db
      .prepare<[string], { spotify_user_id: string | null; spotify_display_name: string | null }>(
        "SELECT spotify_user_id, spotify_display_name FROM SpotifyUserTokens WHERE discord_user_id = ?",
      )
      .get(id);
    return row
      ? {
          linked: true,
          displayName: row.spotify_display_name || row.spotify_user_id || "Spotify account",
        }
      : { linked: false, displayName: null };
  },
  save,
  unlink: db.transaction((id: string) => {
    db.prepare("DELETE FROM SpotifyOAuthState WHERE discord_user_id = ?").run(id);
    db.prepare("DELETE FROM SpotifyUserTokens WHERE discord_user_id = ?").run(id);
  }),
  begin: db.transaction((hash: string, id: string, sessionId: string) => {
    db.prepare("DELETE FROM SpotifyOAuthState WHERE discord_user_id = ? OR expires_at < ?").run(
      id,
      Date.now(),
    );
    db.prepare(
      "INSERT INTO SpotifyOAuthState (state_hash, discord_user_id, session_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hash, id, sessionId, Date.now() + 10 * 60_000);
  }),
  claim(hash: string, id: string, sessionId: string): boolean {
    return (
      db
        .prepare(
          `UPDATE SpotifyOAuthState SET consumed = 1
      WHERE state_hash = ? AND discord_user_id = ? AND session_id = ? AND consumed = 0 AND expires_at > ?`,
        )
        .run(hash, id, sessionId, Date.now()).changes === 1
    );
  },
  complete: db.transaction((hash: string, row: SpotifyUserTokens) => {
    const attempt = db
      .prepare(
        "SELECT 1 FROM SpotifyOAuthState WHERE state_hash = ? AND discord_user_id = ? AND consumed = 1 AND expires_at > ?",
      )
      .get(hash, row.discord_user_id, Date.now());
    if (!attempt) return false; // Unlink/relink cancelled this in-flight callback.
    save(row);
    db.prepare("DELETE FROM SpotifyOAuthState WHERE discord_user_id = ?").run(row.discord_user_id);
    return true;
  }),
  refresh(
    old: SpotifyUserTokens,
    accessToken: string,
    refreshToken: string,
    expiresAt: number,
  ): boolean {
    return (
      db
        .prepare(
          `UPDATE SpotifyUserTokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
      WHERE discord_user_id = ? AND access_token = ? AND refresh_token = ? AND updated_at = ?`,
        )
        .run(
          accessToken,
          refreshToken,
          expiresAt,
          Date.now(),
          old.discord_user_id,
          old.access_token,
          old.refresh_token,
          old.updated_at,
        ).changes === 1
    );
  },
  revoke(old: SpotifyUserTokens) {
    db.prepare(
      "DELETE FROM SpotifyUserTokens WHERE discord_user_id = ? AND access_token = ? AND refresh_token = ? AND updated_at = ?",
    ).run(old.discord_user_id, old.access_token, old.refresh_token, old.updated_at);
  },
  expire(id: string, token: string) {
    db.prepare(
      "UPDATE SpotifyUserTokens SET expires_at = 0 WHERE discord_user_id = ? AND access_token = ?",
    ).run(id, token);
  },
};
