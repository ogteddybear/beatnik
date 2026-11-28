import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("tidal")
  .setDescription("Privately manage your linked Tidal account.")
  .addSubcommand((sc) => sc.setName("link").setDescription("Link or reconnect your Tidal account."))
  .addSubcommand((sc) =>
    sc.setName("unlink").setDescription("Remove your stored Tidal authorization."),
  )
  .addSubcommand((sc) =>
    sc
      .setName("playlists")
      .setDescription("Privately list your Tidal playlists.")
      .addIntegerOption((option) =>
        option.setName("page").setDescription("Page number.").setMinValue(1).setMaxValue(1000),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("load")
      .setDescription("Queue one of your Tidal playlists via YouTube.")
      .addStringOption((option) =>
        option
          .setName("playlist")
          .setDescription("Choose your playlist (autocomplete).")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );
