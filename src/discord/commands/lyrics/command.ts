import { getSession } from "@/core/manager";
import type { CommandExecuter } from "@/discord/commands";
import { findLyrics, lyricsEmbed } from "@/discord/lyrics";
import { MessageFlags } from "discord.js";

export const execute: CommandExecuter = async (interaction) => {
  const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
  const track = session?.player.isPlaying ? session.queue.nowPlaying : undefined;
  if (!track) {
    await interaction.reply({
      content: "Nothing is currently playing in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();
  try {
    const text = await findLyrics(track.channelName, track.title);
    await interaction.editReply({
      embeds: [lyricsEmbed(track.title, track.channelName, text)],
      allowedMentions: { parse: [] },
    });
  } catch {
    await interaction.editReply("Lyrics are temporarily unavailable. Please try again later.");
  }
};
