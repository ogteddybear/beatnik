import { updatePlaylistInLibrary } from "@/core/cache/operations";
import { logEvent } from "@/core/db/guild-events";
import { playlists } from "@/core/db/playlist";
import type { AutocompleteHandler, CommandExecuter } from "@/discord/commands";
import { createDownloadProgressHandler } from "@/discord/playback";
import type { ChatInputCommandInteraction } from "discord.js";

export async function updatePlaylistWithInteraction(
  playlistIntId: number,
  interaction: ChatInputCommandInteraction,
) {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const update = await updatePlaylistInLibrary(
    guildId,
    playlistIntId,
    createDownloadProgressHandler(interaction),
    { userId: interaction.user.id, username: interaction.user.username },
  );
  if (!update || !update.operation) {
    await interaction.editReply("Something went wrong.");
  } else {
    if (update.operation.completed > 0) {
      try {
        logEvent({
          guildId,
          userId: interaction.user.id,
          username: interaction.user.username,
          eventType: "library",
          action: "update",
          metadata: {
            playlistId: update.playlistData.id,
            count: update.operation.completed,
          },
        });
      } catch (error) {
        console.error("Unable to record library event:", error);
      }
    }
    await interaction.editReply(
      `Updated ${update.operation.completed} tracks (${update.operation.errors} errors) in \`${update.playlistData.title}\``,
    );
  }
}

export const autocomplete: AutocompleteHandler = async (interaction) => {
  const focusedValue = interaction.options.getFocused();
  const savedPlaylists = playlists.all();
  const choices = savedPlaylists.map((sp) => ({
    name: sp.title,
    value: sp.int_id,
  }));
  await interaction.respond(
    choices
      .filter((c) => c.name.toLocaleUpperCase().includes(focusedValue.toLocaleUpperCase()))
      .slice(0, 25),
  );
};

export const execute: CommandExecuter = async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const subcommand = interaction.options.getSubcommand();

  await interaction.deferReply();

  const playlistIntIds = [];

  if (subcommand === "playlist") {
    await interaction.editReply("Getting fresh playlist data...");
    playlistIntIds.push(interaction.options.getInteger("playlist", true));
  }

  if (subcommand === "all") {
    const allPlaylists = playlists.all();
    await interaction.editReply(`Updating all playlists (${allPlaylists.length} total)...`);
    playlistIntIds.push(...allPlaylists.map((pl) => pl.int_id));
  }

  for (const playlistIntId of playlistIntIds) {
    await updatePlaylistWithInteraction(playlistIntId, interaction);
  }
};
