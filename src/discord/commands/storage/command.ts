import { guildStorageSummary, storagePercentage } from "@/core/cache/storage";
import type { CommandExecuter } from "@/discord/commands";
import { EmbedBuilder } from "discord.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${sizes[index]}`;
}

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
      `\`${bar}\` **${Math.round(percentage)}%** used\n\n**${formatBytes(used)}** of **${formatBytes(max)}**`,
    );
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
