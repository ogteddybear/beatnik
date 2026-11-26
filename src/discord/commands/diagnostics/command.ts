import { OWNER_ID, diagnosticsEmbed } from "@/core/diagnostics";
import { MessageFlags } from "discord.js";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== OWNER_ID) {
    await interaction.editReply("This command is restricted to the bot owner.");
    return;
  }
  await interaction.editReply({ embeds: [await diagnosticsEmbed()] });
};
