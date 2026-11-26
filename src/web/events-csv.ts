import type { GuildEvent } from "@/core/db/guild-events";

export const EVENTS_CSV_HEADER =
  "Timestamp,Guild ID,User ID,Username,Event Type,Action,Track Name,Metadata\r\n";
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Quoting alone does not stop spreadsheet formula execution.
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function eventCsvRow(event: GuildEvent): string {
  return (
    [
      new Date(event.created_at).toISOString(),
      event.guild_id,
      event.user_id,
      event.username,
      event.event_type,
      event.action,
      event.track_name,
      event.metadata,
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}
