import { getDefaultTextChannel } from "@/core/db/guild-settings";
import { ChannelType, type Guild, PermissionFlagsBits } from "discord.js";

const required = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];
export function configuredTextChannel(guild: Guild) {
  const id = getDefaultTextChannel(guild.id);
  const channel = id ? guild.channels.cache.get(id) : null;
  return channel?.type === ChannelType.GuildText &&
    guild.members.me &&
    channel.permissionsFor(guild.members.me)?.has(required)
    ? channel
    : null;
}
export async function welcomeGuild(guild: Guild) {
  try {
    const channel = guild.systemChannel;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !channel ||
      !channel
        .permissionsFor(me)
        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    )
      return;
    await channel.send({
      content: `Thanks for adding Sashimi! Server managers can configure volume, DJ role, Now Playing channel and autoplay:\nhttps://dis.sashimi.zip/onboard/${guild.id}`,
      allowedMentions: { parse: [] },
    });
  } catch {
    console.warn(`Could not send setup link for guild ${guild.id}.`);
  }
}
