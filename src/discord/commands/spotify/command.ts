import { spotifyUsers } from "@/core/db/spotify-users";
import { providers } from "@/core/manager";
import type { AutocompleteHandler, CommandExecuter } from "@/discord/commands";
import { requireVoiceChannel } from "@/discord/messaging";
import { enqueueTracksAndPlay } from "@/discord/playback";
import { SPOTIFY_LINK_MESSAGE, SpotifyApiError } from "@/providers/spotify/errors";
import { getValidSpotifyAccessToken } from "@/providers/spotify/tokens";
import { getUserSpotifyPlaylists } from "@/providers/spotify/user-api";
import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
} from "discord.js";

export const autocomplete: AutocompleteHandler = async (interaction) => {
  const query = String(interaction.options.getFocused()).toLowerCase();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = async () => {
    const signal = AbortSignal.timeout(1800);
    const matches: { name: string; value: string }[] = [];
    for (let page = 1; page <= 5; page++) {
      const result = await getUserSpotifyPlaylists(interaction.user.id, page, 50, signal);
      for (const item of result.items) {
        if (item.name.toLowerCase().includes(query))
          matches.push({ name: item.name.slice(0, 100) || "Untitled playlist", value: item.id });
        if (matches.length >= 25) return matches;
      }
      if (!result.hasNext) break;
    }
    return matches;
  };
  try {
    const choices = await Promise.race([
      search().catch(() => []),
      new Promise<[]>((resolve) => {
        timer = setTimeout(() => resolve([]), 2000);
      }),
    ]);
    await interaction.respond(choices);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function playlistId(value: string) {
  if (/^[A-Za-z0-9]{1,64}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "open.spotify.com") return null;
    return (
      url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{1,64})\/?$/)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

export async function handleSpotifyCommand(
  interaction: ChatInputCommandInteraction,
  queueTracks = enqueueTracksAndPlay,
): Promise<void> {
  // Every branch and error edits this already-private response.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const userId = interaction.user.id;
    const action = interaction.options.getSubcommand();
    if (action === "link") {
      await interaction.editReply(SPOTIFY_LINK_MESSAGE);
      return;
    }
    if (action === "unlink") {
      spotifyUsers.unlink(userId);
      await interaction.editReply("Spotify account unlinked. Stored tokens have been removed.");
      return;
    }
    if (!(await getValidSpotifyAccessToken(userId))) {
      await interaction.editReply(SPOTIFY_LINK_MESSAGE);
      return;
    }
    if (action === "playlists") {
      const page = interaction.options.getInteger("page") ?? 1;
      const result = await getUserSpotifyPlaylists(userId, page);
      const lines = result.items.map(
        (item, index) =>
          `${(result.page - 1) * 10 + index + 1}. [${escapeMarkdown(item.name.slice(0, 120) || "Untitled playlist")}](https://open.spotify.com/playlist/${item.id}) · ${item.items?.total ?? item.tracks?.total ?? "?"} tracks`,
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("#1db954")
            .setTitle("Your Spotify playlists")
            .setDescription(lines.join("\n") || "No playlists on this page.")
            .setFooter({
              text: `Page ${result.page}${result.hasNext ? ` · Next: /spotify playlists page:${result.page + 1}` : ""}`,
            }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (action === "load") {
      if (!interaction.guildId) {
        await interaction.editReply("Use /spotify load in a server voice channel.");
        return;
      }
      if (!(await requireVoiceChannel(interaction))) return;
      const id = playlistId(interaction.options.getString("playlist", true));
      if (!id) {
        await interaction.editReply(
          "Choose a playlist from autocomplete or provide a valid Spotify playlist URL/ID.",
        );
        return;
      }
      const resolver = providers.find((provider) => provider.id === "spotify-link-resolver");
      if (!resolver) {
        await interaction.editReply("Spotify playback is not configured on this bot.");
        return;
      }
      const playlist = await resolver.getPlaylist(`spotify:playlist:${id}`, {
        requestingUserId: userId,
      });
      if (!playlist?.tracks.length) {
        await interaction.editReply(
          "No playable tracks found. Check playlist access or re-link with /spotify link.",
        );
        return;
      }
      await queueTracks(interaction, playlist.tracks);
      return;
    }
    await interaction.editReply("Unknown Spotify action.");
  } catch (error) {
    await interaction.editReply(
      error instanceof SpotifyApiError && error.status === 401
        ? SPOTIFY_LINK_MESSAGE
        : "Spotify is temporarily unavailable or playlist access was denied. Try again later or run /spotify link.",
    );
  }
}
export const execute: CommandExecuter = async (interaction) => handleSpotifyCommand(interaction);
