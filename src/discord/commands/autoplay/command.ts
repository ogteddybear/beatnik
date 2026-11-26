import { logEvent } from "@/core/db/guild-events";
import { getGuildPlayerSettings, updateGuildPlayerSettings } from "@/core/db/guild-settings";
import { OWNER_ID } from "@/core/diagnostics";
import { MessageFlags, PermissionFlagsBits } from "discord.js";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guildId) {
    await interaction.editReply("Use this command in a server.");
    return;
  }
  const settings = getGuildPlayerSettings(interaction.guildId);
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (
    interaction.user.id !== OWNER_ID &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
    !(settings.dj_role_id && member?.roles.cache.has(settings.dj_role_id))
  ) {
    await interaction.editReply("Manage Server permission or the configured DJ role is required.");
    return;
  }
  const enabled = interaction.options.getBoolean("enabled") ?? !settings.autoplay_enabled;
  updateGuildPlayerSettings(interaction.guildId, { autoplay_enabled: enabled });
  logEvent({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    username: interaction.user.username,
    eventType: "player",
    action: "autoplay_setting",
    metadata: { enabled },
  });
  await interaction.editReply(`Autoplay ${enabled ? "enabled" : "disabled"}.`);
};
