import { Events } from "discord.js";
import "dotenv/config";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { testLibraryConnection } from "./core/cache/operations";
import { startEventArchiver } from "./core/db/event-archive";
import { initProviders, prepareSessionShutdown } from "./core/manager";
import { startDiscord } from "./discord/client";
import { destroyAllVoiceSessions } from "./discord/manager";
import { restoreSessions } from "./discord/restore-sessions";
import { createWebServer } from "./web/server";

const pkg = fs.readFileSync(path.join(".", "package.json"), "utf-8");
export const SASHIMI_VERSION = JSON.parse(pkg).version;

console.log(`
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░░       welcome to Sashimi!      ░░
░░       version ${SASHIMI_VERSION}            ░░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
`);

await initProviders();
await testLibraryConnection();
const client = await startDiscord();
if (!client.isReady()) await once(client, Events.ClientReady);
await restoreSessions(client);
const app = createWebServer(client);
const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Web dashboard listening on port ${port}`);
});
startEventArchiver();
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  prepareSessionShutdown();
  destroyAllVoiceSessions();
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
