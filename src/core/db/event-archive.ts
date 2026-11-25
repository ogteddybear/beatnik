import { setImmediate } from "node:timers/promises";

import { db } from "./client";
import { EVENT_COLUMNS, EVENT_RETENTION_MS } from "./guild-events";

// Both files participate in one SQLite transaction; any failed copy rolls back
// the deletion too. Preserve IDs so existing cursors survive archival.
const moveBatch = db.transaction((cutoff: number) => {
  db.prepare(
    `INSERT INTO event_archive.GuildEvents (${EVENT_COLUMNS})
    SELECT ${EVENT_COLUMNS} FROM main.GuildEvents
    WHERE created_at < ? ORDER BY created_at, id LIMIT 1000`,
  ).run(cutoff);
  return db
    .prepare(
      `DELETE FROM main.GuildEvents WHERE id IN (
    SELECT id FROM main.GuildEvents WHERE created_at < ? ORDER BY created_at, id LIMIT 1000
  )`,
    )
    .run(cutoff).changes;
});

let running = false;
export async function archiveOldEvents(now = Date.now()): Promise<number> {
  if (running) return 0;
  running = true;
  let moved = 0;
  try {
    let count;
    do {
      count = moveBatch(now - EVENT_RETENTION_MS);
      moved += count;
      if (count === 1000) await setImmediate();
    } while (count === 1000);
    return moved;
  } finally {
    running = false;
  }
}

export function startEventArchiver() {
  const run = () =>
    void archiveOldEvents()
      .then((count) => {
        console.info(`Event archive complete: ${count} events moved.`);
      })
      .catch((error: unknown) => {
        console.error("Event archival failed; the current batch was rolled back.", error);
      });
  run();
  const timer = setInterval(run, 24 * 60 * 60_000);
  timer.unref();
  return timer;
}
