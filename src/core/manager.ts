import type { Provider } from "@/providers";
import {
  MockProvider,
  SoundCloudProvider,
  SpotifyLinkResolver,
  YoutubeProvider,
} from "@/providers";
import { log } from "@/shared";

import { config } from "./config";
import { type SavedSession, decodeSession, savedSessions } from "./db/session-state";
import { CorePlayer } from "./player";
import { Queue } from "./queue";

interface GuildSession {
  queue: Queue;
  player: CorePlayer;
  voiceChannelId?: string;
  textChannelId?: string | null;
}

const sessions = new Map<string, GuildSession>();
let shuttingDown = false;

export function saveSessionState(guildId: string) {
  if (shuttingDown) return;
  const session = sessions.get(guildId);
  if (!session?.voiceChannelId) return;
  try {
    if (!session.queue.nowPlaying) {
      savedSessions.delete(guildId);
      return;
    }
    savedSessions.save({
      guild_id: guildId,
      voice_channel_id: session.voiceChannelId,
      text_channel_id: session.textChannelId ?? null,
      queue_json: JSON.stringify(session.queue.tracks),
      current_index: session.queue.currentIndex,
      loop_mode: session.queue.loopMode,
      is_paused: session.player.isPaused || session.player.restorePaused ? 1 : 0,
      updated_at: Date.now(),
    });
  } catch {
    console.warn(`Unable to persist queue for guild ${guildId}.`);
  }
}

export function setSessionChannels(
  guildId: string,
  voiceChannelId: string,
  textChannelId: string | null,
) {
  const session = getOrCreateSession(guildId);
  session.voiceChannelId = voiceChannelId;
  session.textChannelId = textChannelId;
  saveSessionState(guildId);
}

export function hydrateSession(row: SavedSession): GuildSession | undefined {
  if (sessions.has(row.guild_id)) return;
  const tracks = decodeSession(row);
  if (!tracks) return;
  const session = getOrCreateSession(row.guild_id);
  session.queue.tracks = tracks;
  session.queue.currentIndex = row.current_index;
  session.queue.loopMode = row.loop_mode;
  session.player.isPaused = row.is_paused === 1;
  session.player.restorePaused = session.player.isPaused;
  session.voiceChannelId = row.voice_channel_id;
  session.textChannelId = row.text_channel_id;
  return session;
}

export function prepareSessionShutdown() {
  for (const guildId of sessions.keys()) saveSessionState(guildId);
  shuttingDown = true; // Gateway teardown is not an intentional queue deletion.
}

export const providers: Provider[] = [];

export async function initProviders() {
  const youtubeProvider = await YoutubeProvider.create(config.youtube);
  const spotifyLinkResolver = SpotifyLinkResolver.createIfConfigured(youtubeProvider);
  if (spotifyLinkResolver) providers.push(spotifyLinkResolver);
  providers.push(new SoundCloudProvider());
  providers.push(youtubeProvider);
  if (config.useMockProvider) {
    providers.unshift(new MockProvider());
  }
  log({
    component: "CORE",
    name: "PLAYER",
    message: `Initialized provider(s): ${providers.map((p) => p.id).join(", ")}`,
  });
}

export function getOrCreateSession(guildId: string): GuildSession {
  let session = sessions.get(guildId);
  if (!session) {
    const queue = new Queue();
    const player = new CorePlayer(guildId, queue, providers);
    session = { queue, player };
    sessions.set(guildId, session);
    queue.onChange = () => saveSessionState(guildId);
    player.onPersist = () => saveSessionState(guildId);
  }
  return session;
}

export function deleteSession(guildId: string, preserveState = false) {
  if (!shuttingDown && !preserveState) savedSessions.delete(guildId);
  sessions.delete(guildId);
}

export function getSession(guildId: string): GuildSession | undefined {
  return sessions.get(guildId);
}

export function getGuildPlayerState(guildId: string) {
  return sessions.get(guildId)?.player.getState() ?? null;
}
