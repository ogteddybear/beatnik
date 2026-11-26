type Listener = (guildId: string) => void;
const listeners = new Set<Listener>();
export function publishGuildUpdate(guildId: string) {
  for (const listener of listeners) {
    try {
      listener(guildId);
    } catch {
      /* A disconnected dashboard must not disrupt playback. */
    }
  }
}
export function subscribeGuildUpdates(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
