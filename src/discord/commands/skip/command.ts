import { getSession } from "@/core/manager";
import { noQueueReply } from "@/discord/messaging";
import { MessageFlags } from "discord.js";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  const guildId = interaction.guildId;
  const skipIndex = interaction.options.getInteger("track", false);
  if (!guildId) return;
  const session = getSession(guildId);
  if (!session) {
    await interaction.reply(noQueueReply);
    return;
  }
  const { queue, player } = session;
  const currentSongTitle = queue?.nowPlaying?.title ?? "unknown";

  if (skipIndex !== null) {
    if (skipIndex >= 1 && skipIndex <= queue.tracks.length) {
      void player.skip(interaction.user.id, skipIndex - 1).catch(console.error);
    } else {
      await interaction.reply({
        content: "Invalid track number.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    void player.skip(interaction.user.id).catch(console.error);
  }
  await interaction.reply({
    content: `Skipping \`${currentSongTitle}\`...`,
    flags: MessageFlags.Ephemeral,
  });
};
