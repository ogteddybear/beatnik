import { playlists } from "@/core/db/playlist";
import { tracks } from "@/core/db/track";
import { userPlaylists } from "@/core/db/user-playlists";
import type { AutocompleteHandler, CommandExecuter } from "@/discord/commands";
import { enqueueAndPlay } from "@/discord/playback";
import { enqueueTracksAndPlay } from "@/discord/playback";

export const autocomplete: AutocompleteHandler = async (interaction) => {
  const focusedValue = interaction.options.getFocused(true);
  if (focusedValue.name === "name") {
    await interaction.respond(
      userPlaylists
        .list(interaction.user.id)
        .filter((playlist) =>
          playlist.name.toLowerCase().includes(String(focusedValue.value).toLowerCase()),
        )
        .slice(0, 25)
        .map((playlist) => ({ name: playlist.name, value: playlist.name })),
    );
    return;
  }
  if (focusedValue.name === "playlist") {
    const savedPlaylists = playlists.all();
    const choices = savedPlaylists.map((sp) => ({
      name: sp.title,
      value: sp.int_id,
    }));
    await interaction.respond(
      choices
        .filter((c) => c.name.toLocaleUpperCase().includes(focusedValue.value.toLocaleUpperCase()))
        .slice(0, 25),
    );
  } else if (focusedValue.name === "track") {
    const allTracks = tracks.all();
    const choices = allTracks.map((t) => ({
      name: `${t.title} (${t.channelName})`.slice(0, 100),
      value: t.int_id,
    }));
    await interaction.respond(
      choices
        .filter((c) => c.name.toLocaleUpperCase().includes(focusedValue.value.toLocaleUpperCase()))
        .slice(0, 25),
    );
  }
};

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply();

  const subcommand = interaction.options.getSubcommand();
  const playNext = interaction.options.getBoolean("next") ?? false;
  let isShuffle = interaction.options.getBoolean("shuffle") ?? false;
  if (subcommand === "custom") {
    const playlist = userPlaylists.byName(
      interaction.user.id,
      interaction.options.getString("name", true),
    );
    if (!playlist?.tracks.length) {
      await interaction.editReply("No non-empty custom playlist found with that name.");
      return;
    }
    await enqueueTracksAndPlay(interaction, playlist.tracks, { shuffle: isShuffle, playNext });
    return;
  }

  const queryUrls: string[] = [];

  if (subcommand === "all") {
    const allPlaylistIds = playlists.all().map((pl) => pl.int_id);
    allPlaylistIds.forEach((int_id) => {
      const playlist = playlists.getInfo(int_id);
      if (playlist?.url) queryUrls.push(playlist.url);
    });
    isShuffle = true;
  }

  if (subcommand === "playlist") {
    const playlistIntId = interaction.options.getInteger("playlist", true);
    const playlist = playlists.getInfo(playlistIntId);
    if (!playlist) {
      await interaction.editReply("No playlist found.");
      return;
    }
    queryUrls.push(playlist.url);
  }

  if (subcommand === "track") {
    const trackIntId = interaction.options.getInteger("track", true);
    const track = tracks.getInternal(trackIntId);
    if (!track) {
      await interaction.editReply("No track found.");
      return;
    }
    queryUrls.push(track.url);
  }

  await enqueueAndPlay(interaction, queryUrls, { shuffle: isShuffle, playNext });
};
