import { db } from "./client";
import { EVENT_HISTORY } from "./guild-events";

const DAY = 86_400_000;
interface RadioEvent {
  guild_id: string;
  action: string;
  metadata: string | null;
  track_name: string | null;
  created_at: number;
}
const text = (value: unknown, max = 512) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Radio observations are not queue plays or evidence of individual listening. */
export function radioCharts(
  guildIds: string[],
  from: number,
  through: number,
  activeSessionIds: string[] = [],
) {
  const days = Array.from({ length: 30 }, (_, index) => ({
    day: new Date(from + index * DAY).toISOString().slice(0, 10),
    songsObserved: 0,
    sessions: 0,
    connectedSeconds: 0,
    errors: 0,
    reconnects: 0,
  }));
  const dayAt = (time: number) => days[Math.floor((time - from) / DAY)];
  const stations = new Map<
    string,
    {
      station: string;
      service: string;
      songsObserved: number;
      sessions: number;
      connectedSeconds: number;
    }
  >();
  const tracks = new Map<
    string,
    {
      title: string;
      artist: string;
      station: string;
      service: string;
      observations: number;
    }
  >();
  const artists = new Map<
    string,
    { artist: string; station: string; service: string; observations: number }
  >();
  const sessions = new Map<
    string,
    { id: string; stationKey: string; lastTitle: string; started: boolean; connectedAt?: number }
  >();
  const active = new Set(activeSessionIds);
  const addTime = (session: { stationKey: string; connectedAt?: number }, until: number) => {
    if (session.connectedAt === undefined) return;
    let cursor = Math.max(from, session.connectedAt);
    const end = Math.min(until, through - 1);
    while (cursor < end) {
      const next = Math.min(end, (Math.floor(cursor / DAY) + 1) * DAY);
      const seconds = (next - cursor) / 1000;
      const day = dayAt(cursor);
      const station = stations.get(session.stationKey);
      if (day && station) {
        day.connectedSeconds += seconds;
        station.connectedSeconds += seconds;
      }
      cursor = next;
    }
    session.connectedAt = undefined;
  };
  // Iterate rather than load all history. Earlier rows establish boundary state
  // and prevent reconnect duplicates from being counted as a new song today.
  const events = db
    .prepare<[string, number], RadioEvent>(
      `
    SELECT guild_id, action, metadata, track_name, created_at FROM ${EVENT_HISTORY}
    WHERE guild_id IN (SELECT value FROM json_each(?)) AND event_type = 'live'
      AND created_at < ? ORDER BY created_at, id
  `,
    )
    .iterate(JSON.stringify([...new Set(guildIds)]), through);
  for (const event of events) {
    let metadata: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(event.metadata ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      metadata = value as Record<string, unknown>;
    } catch {
      continue;
    }
    const station = text(metadata.station, 128);
    if (!station) continue;
    const service = text(metadata.service, 128) || "Radio";
    const stationKey = JSON.stringify([station, service]);
    if (!stations.has(stationKey))
      stations.set(stationKey, {
        station,
        service,
        songsObserved: 0,
        sessions: 0,
        connectedSeconds: 0,
      });
    const id = text(metadata.sessionId, 128);
    const key = JSON.stringify([event.guild_id, stationKey, id || "legacy"]);
    let session = sessions.get(key);
    if (!session) {
      session = { id, stationKey, lastTitle: "", started: false };
      sessions.set(key, session);
    }
    const day = event.created_at >= from ? dayAt(event.created_at) : undefined;
    const stationRow = stations.get(stationKey);
    if (!stationRow) continue;
    if (event.action === "start" && !session.started) {
      session.started = true;
      if (day) {
        day.sessions++;
        stationRow.sessions++;
      }
    }
    if (event.action === "connected") session.connectedAt ??= event.created_at;
    if (
      ["reconnect", "connection_failed", "stream_error", "unavailable", "stop"].includes(
        event.action,
      )
    )
      addTime(session, event.created_at);
    if (day && event.action === "reconnect") day.reconnects++;
    if (day && ["connection_failed", "stream_error"].includes(event.action)) day.errors++;
    if (event.action === "track_change") {
      const title = text(metadata.streamTitle) || text(event.track_name);
      if (title && title !== session.lastTitle) {
        session.lastTitle = title;
        if (day) {
          day.songsObserved++;
          stationRow.songsObserved++;
          const artist = text(metadata.artist);
          const trackKey = JSON.stringify([stationKey, title]);
          const track = tracks.get(trackKey) ?? {
            title,
            artist,
            station,
            service,
            observations: 0,
          };
          track.observations++;
          tracks.set(trackKey, track);
          if (artist) {
            const artistKey = JSON.stringify([stationKey, artist]);
            const entry = artists.get(artistKey) ?? { artist, station, service, observations: 0 };
            entry.observations++;
            artists.set(artistKey, entry);
          }
        }
      }
    }
    if (event.action === "stop") sessions.delete(key);
  }
  // Incomplete historical sessions are not assumed to have stayed connected.
  for (const session of sessions.values()) {
    if (session.id && active.has(session.id)) addTime(session, through - 1);
  }
  const stationRows = [...stations.values()].filter(
    (row) => row.songsObserved || row.sessions || row.connectedSeconds,
  );
  stationRows.sort(
    (a, b) => b.songsObserved - a.songsObserved || a.station.localeCompare(b.station),
  );
  return {
    days,
    stations: stationRows,
    topTracks: [...tracks.values()]
      .sort(
        (a, b) =>
          b.observations - a.observations ||
          a.title.localeCompare(b.title) ||
          a.station.localeCompare(b.station),
      )
      .slice(0, 10),
    topArtists: [...artists.values()]
      .sort(
        (a, b) =>
          b.observations - a.observations ||
          a.artist.localeCompare(b.artist) ||
          a.station.localeCompare(b.station),
      )
      .slice(0, 10),
    totals: days.reduce(
      (total, day) => ({
        songsObserved: total.songsObserved + day.songsObserved,
        sessions: total.sessions + day.sessions,
        connectedSeconds: total.connectedSeconds + day.connectedSeconds,
        errors: total.errors + day.errors,
        reconnects: total.reconnects + day.reconnects,
      }),
      { songsObserved: 0, sessions: 0, connectedSeconds: 0, errors: 0, reconnects: 0 },
    ),
  };
}
