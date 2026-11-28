import { db } from "./client";

export interface TidalUserTokens {
  discord_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tidal_user_id: string | null;
  tidal_display_name: string | null;
  updated_at: number;
}

const save = (row: TidalUserTokens) =>
  db
    .prepare(
      `INSERT INTO TidalUserTokens
    (discord_user_id, access_token, refresh_token, expires_at, tidal_user_id, tidal_display_name, updated_at)
    VALUES (@discord_user_id, @access_token, @refresh_token, @expires_at, @tidal_user_id, @tidal_display_name, @updated_at)
    ON CONFLICT(discord_user_id) DO UPDATE SET access_token=excluded.access_token,
    refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
    tidal_user_id=excluded.tidal_user_id, tidal_display_name=excluded.tidal_display_name,
    updated_at=excluded.updated_at`,
    )
    .run(row);

export const tidalUsers = {
  get: (id: string) =>
    db
      .prepare<[string], TidalUserTokens>("SELECT * FROM TidalUserTokens WHERE discord_user_id = ?")
      .get(id),
  summary(id: string) {
    const row = db
      .prepare<[string], Pick<TidalUserTokens, "tidal_user_id" | "tidal_display_name">>(
        "SELECT tidal_user_id, tidal_display_name FROM TidalUserTokens WHERE discord_user_id = ?",
      )
      .get(id);
    return row
      ? {
          linked: true,
          displayName: row.tidal_display_name || row.tidal_user_id || "Tidal account",
        }
      : { linked: false, displayName: null };
  },
  save,
  unlink: db.transaction((id: string) => {
    db.prepare("DELETE FROM TidalOAuthState WHERE discord_user_id = ?").run(id);
    db.prepare("DELETE FROM TidalUserTokens WHERE discord_user_id = ?").run(id);
  }),
  begin: db.transaction((hash: string, id: string, sessionId: string) => {
    db.prepare("DELETE FROM TidalOAuthState WHERE discord_user_id = ? OR expires_at < ?").run(
      id,
      Date.now(),
    );
    db.prepare(
      "INSERT INTO TidalOAuthState (state_hash, discord_user_id, session_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hash, id, sessionId, Date.now() + 10 * 60_000);
  }),
  claim(hash: string, id: string, sessionId: string): boolean {
    return (
      db
        .prepare(
          `UPDATE TidalOAuthState SET consumed = 1
      WHERE state_hash = ? AND discord_user_id = ? AND session_id = ? AND consumed = 0 AND expires_at > ?`,
        )
        .run(hash, id, sessionId, Date.now()).changes === 1
    );
  },
  complete: db.transaction((hash: string, row: TidalUserTokens) => {
    if (
      !db
        .prepare(
          `SELECT 1 FROM TidalOAuthState
      WHERE state_hash = ? AND discord_user_id = ? AND consumed = 1 AND expires_at > ?`,
        )
        .get(hash, row.discord_user_id, Date.now())
    )
      return false;
    save(row);
    db.prepare("DELETE FROM TidalOAuthState WHERE discord_user_id = ?").run(row.discord_user_id);
    return true;
  }),
  refresh(old: TidalUserTokens, access: string, refresh: string, expires: number): boolean {
    return (
      db
        .prepare(
          `UPDATE TidalUserTokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
      WHERE discord_user_id = ? AND access_token = ? AND refresh_token = ? AND updated_at = ?`,
        )
        .run(
          access,
          refresh,
          expires,
          Date.now(),
          old.discord_user_id,
          old.access_token,
          old.refresh_token,
          old.updated_at,
        ).changes === 1
    );
  },
  revoke(old: TidalUserTokens) {
    db.prepare(
      `DELETE FROM TidalUserTokens
      WHERE discord_user_id = ? AND access_token = ? AND refresh_token = ? AND updated_at = ?`,
    ).run(old.discord_user_id, old.access_token, old.refresh_token, old.updated_at);
  },
  expire(id: string, token: string) {
    db.prepare(
      "UPDATE TidalUserTokens SET expires_at = 0 WHERE discord_user_id = ? AND access_token = ?",
    ).run(id, token);
  },
};
