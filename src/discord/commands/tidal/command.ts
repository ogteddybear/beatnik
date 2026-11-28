import { isProviderEnabled } from "@/core/db/bot-settings";
import { tidalUsers } from "@/core/db/tidal-users";
import { providers } from "@/core/manager";
import type { AutocompleteHandler, CommandExecuter } from "@/discord/commands";
import { requireVoiceChannel } from "@/discord/messaging";
import { enqueueTracksAndPlay } from "@/discord/playback";
import type { ProviderTrack } from "@/providers/provider";
import { getPlaylistTracks, getUserPlaylists } from "@/providers/tidal/api";
import { TIDAL_LINK_MESSAGE, TidalNotLinkedError } from "@/providers/tidal/errors";
import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
} from "discord.js";

export const autocomplete: AutocompleteHandler = async (interaction) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = String(interaction.options.getFocused()).toLowerCase();
    const items = await Promise.race([
      getUserPlaylists(interaction.user.id, AbortSignal.timeout(1800)).catch(() => []),
      new Promise<[]>((resolve) => {
        timer = setTimeout(() => resolve([]), 2000);
      }),
    ]);
    await interaction.respond(
      items
        .filter((item) => item.name.toLowerCase().includes(query))
        .filter((item) => item.id.length <= 100)
        .slice(0, 25)
        .map((item) => ({ name: item.name.slice(0, 100), value: item.id })),
    );
  } catch {
    await interaction.respond([]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export async function handleTidalCommand(
  interaction: ChatInputCommandInteraction,
  queueTracks = enqueueTracksAndPlay,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const userId = interaction.user.id;
    const action = interaction.options.getSubcommand();
    if (action === "link") {
      await interaction.editReply(TIDAL_LINK_MESSAGE);
      return;
    }
    if (action === "unlink") {
      tidalUsers.unlink(userId);
      await interaction.editReply("Tidal account unlinked. Stored tokens have been removed.");
      return;
    }
    const playlists = await getUserPlaylists(userId);
    if (action === "playlists") {
      const page = interaction.options.getInteger("page") ?? 1;
      const lines = playlists
        .slice((page - 1) * 10, page * 10)
        .map(
          (item, index) =>
            `${(page - 1) * 10 + index + 1}. [${escapeMarkdown(item.name.slice(0, 120))}](https://tidal.com/browse/playlist/${encodeURIComponent(item.id)}) · ${item.trackCount} tracks`,
        );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("#00ffff")
            .setTitle("Your Tidal playlists")
            .setDescription(lines.join("\n") || "No playlists on this page.")
            .setFooter({
              text: `Page ${page}${playlists.length > page * 10 ? ` · Next: /tidal playlists page:${page + 1}` : ""}`,
            }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (action === "load") {
      if (!interaction.guildId) {
        await interaction.editReply("Use /tidal load in a server voice channel.");
        return;
      }
      if (!(await requireVoiceChannel(interaction))) return;
      const id = interaction.options.getString("playlist", true);
      if (!playlists.some((item) => item.id === id)) {
        await interaction.editReply("Choose one of your Tidal playlists from autocomplete.");
        return;
      }
      const youtube = providers.find(
        (provider) => provider.id === "youtube" && isProviderEnabled(provider.id),
      );
      if (!youtube?.search) {
        await interaction.editReply(
          "YouTube playback is not configured or is disabled on this bot.",
        );
        return;
      }
      const items = await getPlaylistTracks(userId, id);
      const tracks: (ProviderTrack | null)[] = Array.from({ length: items.length }, () => null);
      let cursor = 0;
      const search = youtube.search.bind(youtube);
      // Bound API pressure while preserving playlist order, not completion order.
      const worker = async () => {
        while (cursor < items.length) {
          const index = cursor++;
          const item = items[index];
          try {
            tracks[index] = await search(`${item.artist} ${item.title}`.trim());
          } catch (error) {
            if (error instanceof Error && error.message === "No YouTube search results found.")
              continue;
            throw error;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
      const successful = tracks.filter((track): track is ProviderTrack => track !== null);
      if (!successful.length) {
        await interaction.editReply("No playable YouTube matches found for this Tidal playlist.");
        return;
      }
      await queueTracks(interaction, successful);
      return;
    }
    await interaction.editReply("Unknown Tidal action.");
  } catch (error) {
    await interaction.editReply(
      error instanceof TidalNotLinkedError
        ? TIDAL_LINK_MESSAGE
        : "Tidal is temporarily unavailable or playlist access was denied. Try again later or run /tidal link.",
    );
  }
}

export const execute: CommandExecuter = async (interaction) => handleTidalCommand(interaction);
