import { getBotSettings } from "@/core/db/bot-settings";
import { getBeatTimeString } from "@/shared";
import type { ActivitiesOptions, Client, PresenceStatusData } from "discord.js";
import { ActivityType } from "discord.js";

function getIdleActivity() {
  const activity: ActivitiesOptions = {
    name: `@${getBeatTimeString()}`,
    type: ActivityType.Playing,
  };
  return activity;
}

function updatePresence(
  client: Client,
  status: PresenceStatusData,
  activity: ActivitiesOptions,
): void {
  client.user?.setPresence({ status, activities: [activity] });
  return;
}

export function applyConfiguredPresence(client: Client) {
  const settings = getBotSettings();
  const activity = settings.activity
    ? { name: settings.activity, type: ActivityType.Playing }
    : getIdleActivity();
  if (
    client.user?.presence.activities[0]?.name !== activity.name ||
    client.user?.presence.status !== settings.status
  )
    updatePresence(client, settings.status, activity);
}
export function startPresenceLifecycle(client: Client) {
  function checkStatusAndUpdate() {
    const user = client.user;
    if (!user) return;
    applyConfiguredPresence(client);
  }
  checkStatusAndUpdate();
  return setInterval(checkStatusAndUpdate, 10000);
}
