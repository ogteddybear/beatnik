import { spotifyUsers } from "@/core/db/spotify-users";
import type { CommandExecuter } from "@/discord/commands";
import { enqueueAndPlay } from "@/discord/playback";
import { SpotifyPlaylistUnavailableError } from "@/providers/spotify/errors";

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply();
  const query = interaction.options.getString("query", true);
  try {
    await enqueueAndPlay(interaction, [query], {
      shuffle: interaction.options.getBoolean("shuffle") ?? false,
      playNext: interaction.options.getBoolean("next") ?? false,
    });
  } catch (error) {
    if (
      error instanceof SpotifyPlaylistUnavailableError &&
      !spotifyUsers.summary(interaction.user.id).linked
    ) {
      await interaction.editReply(
        "This Spotify playlist may be private. Run /spotify link to authorize your account, then try again.",
      );
      return;
    }
    throw error;
  }
};
