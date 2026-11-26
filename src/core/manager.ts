import type { Provider } from "@/providers";
import {
  MockProvider,
  SoundCloudProvider,
  SpotifyLinkResolver,
  YoutubeProvider,
} from "@/providers";
import { log } from "@/shared";

import { config } from "./config";
import { CorePlayer } from "./player";
import { Queue } from "./queue";

interface GuildSession {
  queue: Queue;
  player: CorePlayer;
}

const sessions = new Map<string, GuildSession>();

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
  }
  return session;
}

export function deleteSession(guildId: string) {
  sessions.delete(guildId);
}

export function getSession(guildId: string): GuildSession | undefined {
  return sessions.get(guildId);
}

export function getGuildPlayerState(guildId: string) {
  return sessions.get(guildId)?.player.getState() ?? null;
}
