import { db } from "./client";

export const PROVIDER_IDS = ["youtube", "soundcloud", "spotify-link-resolver"] as const;
export interface BotSettings {
  status: "online" | "idle" | "dnd" | "invisible";
  activity: string;
  providers: Record<string, boolean>;
}
export function getBotSettings(): BotSettings {
  const row = db
    .prepare<[], { settings_json: string }>("SELECT settings_json FROM BotSettings WHERE id=1")
    .get();
  return row
    ? (JSON.parse(row.settings_json) as BotSettings)
    : {
        status: "online",
        activity: "",
        providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, true])),
      };
}
export function saveBotSettings(input: unknown): BotSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid settings");
  const value = input as BotSettings;
  if (
    !["online", "idle", "dnd", "invisible"].includes(value.status) ||
    typeof value.activity !== "string" ||
    value.activity.length > 128 ||
    [...value.activity].some((character) => character.charCodeAt(0) < 32) ||
    !value.providers ||
    typeof value.providers !== "object" ||
    Array.isArray(value.providers) ||
    Object.keys(value.providers).length !== PROVIDER_IDS.length ||
    !PROVIDER_IDS.every((id) => typeof value.providers[id] === "boolean") ||
    Object.keys(value).some((key) => !["status", "activity", "providers"].includes(key))
  )
    throw new Error("Invalid settings");
  const settings = {
    status: value.status,
    activity: value.activity.trim(),
    providers: value.providers,
  };
  db.prepare(
    "INSERT INTO BotSettings (id,settings_json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json",
  ).run(JSON.stringify(settings));
  return settings;
}
export function isProviderEnabled(id: string) {
  const settings = getBotSettings();
  return (
    settings.providers[id] !== false &&
    (id !== "spotify-link-resolver" || settings.providers.youtube !== false)
  );
}
