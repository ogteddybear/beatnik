import { decodeSession, savedSessions } from "@/core/db/session-state";
import { deleteSession, getSession, hydrateSession } from "@/core/manager";
import type { CorePlayer } from "@/core/player";
import type { Client, TextBasedChannel, VoiceBasedChannel } from "discord.js";

import { deleteVoiceSession, getOrCreateVoiceSession } from "./manager";

export async function restoreSessions(
  client: Client,
  connect: (
    voice: VoiceBasedChannel,
    text: TextBasedChannel | null,
    player: CorePlayer,
  ) => unknown = getOrCreateVoiceSession,
  timeoutMs = 15000,
) {
  for (const row of savedSessions.all()) {
    if (getSession(row.guild_id)) continue;
    if (!decodeSession(row) || !client.guilds.cache.has(row.guild_id)) {
      savedSessions.delete(row.guild_id);
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let restored: ReturnType<typeof hydrateSession>;
    try {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) {
        savedSessions.delete(row.guild_id);
        continue;
      }
      const voice = await guild.channels.fetch(row.voice_channel_id);
      if (!voice?.isVoiceBased()) {
        savedSessions.delete(row.guild_id);
        continue;
      }
      const text = row.text_channel_id
        ? await guild.channels.fetch(row.text_channel_id).catch(() => null)
        : null;
      const session = hydrateSession(row);
      if (!session) continue;
      restored = session;
      connect(voice, text?.isTextBased() ? text : null, session.player);
      await Promise.race([
        session.player.play(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Restore timeout")), timeoutMs);
        }),
      ]);
      if (session.player.isPlaying)
        console.info(
          `Restored queue for guild ${row.guild_id} (${session.queue.tracks.length} tracks)`,
        );
    } catch {
      if (restored && getSession(row.guild_id) === restored) {
        restored.player.suspend();
        deleteVoiceSession(row.guild_id);
        deleteSession(row.guild_id, true);
      }
      console.warn(
        `Could not restore queue for guild ${row.guild_id}; saved state is retained for a later restart.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
