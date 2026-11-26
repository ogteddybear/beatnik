import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("spotify")
  .setDescription("Privately manage your linked Spotify account.")
  .addSubcommand((sc) => sc.setName("link").setDescription("Link or change your Spotify account."))
  .addSubcommand((sc) =>
    sc.setName("unlink").setDescription("Remove your stored Spotify authorization."),
  )
  .addSubcommand((sc) =>
    sc
      .setName("playlists")
      .setDescription("Privately list your Spotify playlists.")
      .addIntegerOption((option) =>
        option.setName("page").setDescription("Page number.").setMinValue(1).setMaxValue(1000),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("load")
      .setDescription("Queue a Spotify playlist you can access.")
      .addStringOption((option) =>
        option
          .setName("playlist")
          .setDescription("Your playlist name (autocomplete), ID, or Spotify URL.")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );
