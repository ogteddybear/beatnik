import type { Provider, ProviderTrack } from "@/providers";

import { isProviderEnabled } from "./db/bot-settings";

// Metadata search only; no SABR, token minting or streaming implementation changes.
export async function findAutoplayTrack(
  last: ProviderTrack,
  providers: Provider[],
  recent: ProviderTrack[] = [],
): Promise<ProviderTrack | null> {
  const youtube = providers.find(
    (provider) => provider.id === "youtube" && isProviderEnabled(provider.id),
  );
  if (!youtube?.getRelatedTrack && !youtube?.search) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      youtube.getRelatedTrack
        ? youtube.getRelatedTrack(
            last,
            recent.filter((track) => track.providerId === youtube.id).map((track) => track.id),
          )
        : (youtube.search?.(`${last.title} ${last.channelName} related music`) ??
          Promise.resolve(null)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 8000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
