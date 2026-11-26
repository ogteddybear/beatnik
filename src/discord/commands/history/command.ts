import { getGuildPlaybackHistory } from "@/core/db/guild-events";
import type { CommandExecuter } from "@/discord/commands";
import { EmbedBuilder, MessageFlags, escapeMarkdown } from "discord.js";

export const execute: CommandExecuter = async (interaction) => {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "Use /history in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const events = getGuildPlaybackHistory(interaction.guildId);
  const description = events
    .map((event, index) => {
      const title = escapeMarkdown((event.track_name ?? "Unknown track").slice(0, 160));
      return `${index + 1}. **${title}** · <t:${Math.floor(event.created_at / 1000)}:R>`;
    })
    .join("\n");
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor("#0a203b")
        .setTitle("Recently played")
        .setDescription(description || "No playback history recorded yet."),
    ],
    allowedMentions: { parse: [] },
  });
};
