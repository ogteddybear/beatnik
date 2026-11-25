import type { LibraryOperationResult } from "@/core/cache/operations";
import { addPlaylistToLibrary, addTrackToLibrary } from "@/core/cache/operations";
import { logEvent } from "@/core/db/guild-events";
import { resolveQuery } from "@/core/resolvers";
import type { CommandExecuter } from "@/discord/commands";
import { createDownloadProgressHandler } from "@/discord/playback";

export const execute: CommandExecuter = async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const query = interaction.options.getString("query", true);
  await interaction.deferReply();

  await interaction.editReply(
    `Finding metadata for your query... please wait (this can take a while).`,
  );

  const { type, metadata, provider } = await resolveQuery(query);
  if (!metadata) return;

  const count = type === "playlist" ? metadata.tracks.length : 1;
  await interaction.editReply(`Adding and downloading ${count} track(s)...`);

  let operation: LibraryOperationResult | null;

  if (type === "playlist") {
    operation = await addPlaylistToLibrary(
      guildId,
      metadata,
      provider,
      createDownloadProgressHandler(interaction),
    );
  } else if (type === "track" || type === "search") {
    operation = await addTrackToLibrary(guildId, metadata, provider);
  } else {
    operation = null;
  }

  const title = metadata.title;

  if (!operation) {
    await interaction.editReply(`Something went wrong.`);
  } else if (operation.error === "EXISTS") {
    await interaction.editReply(`${title} was already added.`);
  } else {
    if (operation.completed > 0) {
      try {
        logEvent(guildId, interaction.user.id, "library", "add", {
          providerId: provider.id,
          trackId: type === "playlist" ? undefined : metadata.id,
          playlistId: type === "playlist" ? metadata.id : undefined,
          count: operation.completed,
        });
      } catch (error) {
        console.error("Unable to record library event:", error);
      }
    }
    await interaction.editReply(
      `${operation.updated ? "Updated" : "Added"} ${operation.completed} tracks (${operation.errors} errors) for \`${title ?? "unknown"}\``,
    );
  }
};
