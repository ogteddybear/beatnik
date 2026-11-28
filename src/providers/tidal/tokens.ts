import { tidalUsers } from "@/core/db/tidal-users";

import { TidalApiError, TidalNotLinkedError } from "./errors";

export function tidalClientConfig() {
  const id = process.env.TIDAL_CLIENT_ID;
  const secret = process.env.TIDAL_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

const pending = new Map<string, Promise<string | null>>();

export async function getValidTidalAccessToken(discordUserId: string): Promise<string | null> {
  const row = tidalUsers.get(discordUserId);
  if (!row) return null;
  if (row.expires_at > Date.now() + 30_000) return row.access_token;
  const existing = pending.get(discordUserId);
  if (existing) return existing;
  const task = (async () => {
    const config = tidalClientConfig();
    if (!config) throw new TidalApiError(503);
    let response: Response;
    try {
      response = await fetch("https://auth.tidal.com/v1/oauth2/token", {
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
    } catch {
      throw new TidalApiError(503);
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: string };
      if (error.error === "invalid_grant") {
        tidalUsers.revoke(row);
        throw new TidalNotLinkedError();
      }
      throw new TidalApiError(response.status);
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
      throw new TidalApiError(502);
    const refresh =
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : row.refresh_token;
    const expires = Date.now() + body.expires_in * 1000;
    if (!Number.isSafeInteger(expires)) throw new TidalApiError(502);
    if (!tidalUsers.refresh(row, body.access_token, refresh, expires))
      throw new TidalNotLinkedError();
    return body.access_token;
  })();
  pending.set(discordUserId, task);
  try {
    return await task;
  } finally {
    if (pending.get(discordUserId) === task) pending.delete(discordUserId);
  }
}
