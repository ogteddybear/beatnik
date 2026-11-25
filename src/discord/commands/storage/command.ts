import { guildStorageSummary, storagePercentage } from "@/core/cache/storage";
import { MB } from "@/core/db/guild-settings";
import type { CommandExecuter } from "@/discord/commands";
import { EmbedBuilder } from "discord.js";

export function storageEmbed(used: number, max: number): EmbedBuilder {
  const percentage = storagePercentage(used, max);
  // Clamp only the visual bar; keep the actual percentage for over-quota usage.
  const filled =
    max === 0 ? (used > 0 ? 10 : 0) : Math.max(0, Math.min(10, Math.round((used / max) * 10)));
  const bar = `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
  const warning = used > max || percentage > 90;
  return new EmbedBuilder()
    .setTitle(`${warning ? "⚠️ " : ""}Server storage`)
    .setColor(used > max ? 0xdc3545 : percentage > 90 ? 0xffc107 : 0x0d6efd)
    .setDescription(
      `\`${bar}\` ${Math.round(percentage)}% (${(used / MB).toFixed(1)} MB / ${(max / MB).toFixed(1)} MB)`,
    )
    .setFooter({
      text: "Guild cache only. Shared audio is excluded. A 0 MB quota disables new cache writes; streaming still works.",
    });
}

export const execute: CommandExecuter = async (interaction) => {
  if (!interaction.guildId) {
    await interaction.reply("Use /storage in a server.");
    return;
  }
  await interaction.deferReply();
  const { storageBytes, maxStorageBytes } = await guildStorageSummary(interaction.guildId);
  await interaction.editReply({ embeds: [storageEmbed(storageBytes, maxStorageBytes)] });
};
