import { getOrCreateSession } from "@/core/manager";
import { getOrCreateVoiceSession, getVoiceSession } from "@/discord/manager";
import { requireVoiceChannel } from "@/discord/messaging";
import { LIVE_SERVICE, LIVE_STATIONS } from "@/providers/live/stations";
import { proxyImageUrl } from "../../../utils/image-proxy";
import { EmbedBuilder, escapeMarkdown } from "discord.js";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply();
  if (!interaction.guildId) {
    await interaction.editReply("Use /live in a server voice channel.");
    return;
  }
  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;
  const key = interaction.options.getString("station", true);
  if (!Object.hasOwn(LIVE_STATIONS, key)) {
    await interaction.editReply("Unknown radio station.");
    return;
  }
  const existing = getVoiceSession(interaction.guildId);
  if (existing && existing.channelId !== voiceChannel.id) {
    await interaction.editReply("Join Sashimi’s voice channel to change the station.");
    return;
  }
  const station = LIVE_STATIONS[key as keyof typeof LIVE_STATIONS];
  const { player } = getOrCreateSession(interaction.guildId);
  const voice = getOrCreateVoiceSession(voiceChannel, interaction.channel, player, {
    userId: interaction.user.id,
    username: interaction.user.username,
  });
  const accepted = await voice.runControl(async () => {
    await voice.prepareLiveReply(interaction.channelId);
    await player.playLive(station.url, station.name, {
      userId: interaction.user.id,
      username: interaction.user.username,
    });
    const embed = new EmbedBuilder()
      .setColor("#0a203b")
      .setAuthor({ name: `${LIVE_SERVICE} · Live radio` })
      .setThumbnail(proxyImageUrl(station.artworkUrl))
      .setDescription(
        `📻 ${player.isLoading ? "Connecting to" : "Streaming"} **${station.name}** — ${station.genre}. Use \`/stop\` to end the broadcast.`,
      );
    const metadata = player.getState()?.liveMetadata;
    if (metadata)
      embed.addFields({
        name: "On air",
        value: escapeMarkdown(metadata.streamTitle).slice(0, 1024),
      });
    await interaction.editReply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    voice.watchLiveReply(await interaction.fetchReply());
  });
  if (!accepted)
    await interaction.editReply("Another player action is in progress. Please try again.");
};
