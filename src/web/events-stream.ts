import { subscribeGuildUpdates } from "@/core/live-updates";
import type express from "express";

export interface StreamScope {
  userId: string;
  guildIds: string[];
}
export function mountEventsStream(
  app: express.Express,
  authorize: (req: express.Request) => Promise<StreamScope | null>,
  heartbeatMs = 15000,
) {
  const connections = new Map<string, number>();
  app.get("/api/events/stream", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    let scope: StreamScope | null;
    try {
      scope = await authorize(req);
    } catch {
      return res.sendStatus(502);
    }
    if (!scope) return res.sendStatus(401);
    const userId = scope.userId;
    const count = connections.get(userId) ?? 0;
    if (count >= 10) return res.sendStatus(429);
    connections.set(userId, count + 1);
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false,
      running = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dirtyGuilds = new Set<string>();
    let unsubscribe = () => {
      /* Installed below. */
    };
    function cleanup() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      const remaining = (connections.get(userId) ?? 1) - 1;
      if (remaining > 0) connections.set(userId, remaining);
      else connections.delete(userId);
    }
    function end() {
      cleanup();
      res.end();
    }
    function send() {
      // Never queue unbounded data behind a slow client. Reconnect resynchronizes.
      if (!closed && !res.write("event: refresh\ndata: {}\n\n")) end();
    }
    async function flush(resync = false) {
      timer = undefined;
      if (closed) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const changed = [...dirtyGuilds];
      dirtyGuilds.clear();
      try {
        const current = await authorize(req);
        if (closed) return;
        if (!current || current.userId !== userId) {
          end();
          return;
        }
        scope = current;
        if (resync || changed.some((guildId) => current.guildIds.includes(guildId))) send();
      } catch {
        end();
      } finally {
        running = false;
        if (pending && !closed) {
          pending = false;
          schedule();
        }
      }
    }
    function schedule() {
      if (!closed && !timer) timer = setTimeout(() => void flush(), 200);
    }
    unsubscribe = subscribeGuildUpdates((guildId) => {
      if (scope?.guildIds.includes(guildId)) {
        dirtyGuilds.add(guildId);
        schedule();
      }
    });
    const heartbeat = setInterval(() => void flush(true), heartbeatMs);
    heartbeat.unref();
    res.once("close", cleanup);
    res.once("error", cleanup);
    send();
  });
}
