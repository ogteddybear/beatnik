import type { Client } from "discord.js";

export interface InviteResult {
  status: "confirmed" | "pending" | "cancelled" | "invalid" | "failed";
  createdAt: number;
  guildId?: string;
  nextCheckAt?: number;
  authorizationComplete?: boolean;
}

export const INVITE_CONFIRMATION_TTL = 10 * 60_000;

export function discordGuildId(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : undefined;
}

/**
 * Cache absence is not proof of a failed install: the gateway and OAuth callback
 * can arrive in either order. Confirm positively, otherwise remain pending.
 */
export function createInviteVerifier(client: Client, botToken: string) {
  const inFlight = new Map<string, Promise<boolean>>();
  const cooldowns = new Map<string, number>();
  return async (result: InviteResult): Promise<void> => {
    if (result.status !== "pending" || !result.guildId) return;
    if (Date.now() < result.createdAt || Date.now() - result.createdAt >= INVITE_CONFIRMATION_TTL)
      return;
    const id = result.guildId;
    if (client.guilds.cache.has(id)) {
      result.status = "confirmed";
      return;
    }
    if (Date.now() < (result.nextCheckAt ?? 0)) return;
    const cooldown = cooldowns.get(id) ?? 0;
    if (Date.now() < cooldown) {
      result.nextCheckAt = cooldown;
      return;
    }
    result.nextCheckAt = Date.now() + 15_000;
    cooldowns.delete(id);
    cooldowns.set(id, result.nextCheckAt);
    if (cooldowns.size > 256) {
      const oldest = cooldowns.keys().next().value;
      if (oldest) cooldowns.delete(oldest);
    }
    let check = inFlight.get(id);
    if (!check) {
      check = (async () => {
        try {
          const response = await fetch(`https://discord.com/api/v10/guilds/${id}`, {
            headers: { Authorization: `Bot ${botToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) {
            if (response.status === 429) {
              const seconds = Number(response.headers.get("retry-after"));
              result.nextCheckAt =
                Date.now() + Math.max(15_000, Number.isFinite(seconds) ? seconds * 1_000 : 60_000);
              cooldowns.set(id, result.nextCheckAt);
            }
            return false;
          }
          const guild: unknown = await response.json();
          return Boolean(guild && typeof guild === "object" && "id" in guild && guild.id === id);
        } catch {
          // No request, credential, response body, or exception logging here.
          return false;
        }
      })();
      inFlight.set(id, check);
    }
    try {
      if (await check) {
        result.status = "confirmed";
        cooldowns.delete(id);
      }
    } finally {
      if (inFlight.get(id) === check) inFlight.delete(id);
    }
  };
}

export function invitePresentation(result?: InviteResult) {
  switch (result?.status) {
    case "confirmed":
      return {
        title: "Sashimi is in your server",
        message: "Installation confirmed. You can return to your dashboard.",
        state: "success",
      };
    case "pending":
      return {
        title: "Installation confirmation pending",
        message: result.authorizationComplete
          ? "Discord authorization completed. Sashimi may already be in your server; we’re waiting for membership confirmation. You don’t need to invite it again."
          : "We couldn’t finish verifying the authorization response. Sashimi may already be in your server. Check Discord or your dashboard before inviting it again.",
        state: "warning",
      };
    case "cancelled":
      return {
        title: "Installation cancelled",
        message: "The Discord authorization was cancelled. Any existing installation is unchanged.",
        state: "warning",
      };
    case "invalid":
      return {
        title: "We couldn’t verify this callback",
        message:
          "This installation request is invalid, expired, or already used. This does not mean the bot wasn’t added. Check your server or dashboard before starting another invite.",
        state: "error",
      };
    case "failed":
      return {
        title: "Authorization could not be completed",
        message:
          "Discord returned an authorization error or no authorization code. Check your server or dashboard before starting another invite; an existing installation is unchanged.",
        state: "error",
      };
    default:
      return {
        title: "Add Sashimi to your server",
        message: "Start from the Invite Sashimi button to install the bot.",
        state: "neutral",
      };
  }
}
