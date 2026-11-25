import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { testLibraryConnection } from "./core/cache/operations";
import { initProviders } from "./core/manager";
import { startDiscord } from "./discord/client";
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
const app = createWebServer(client);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`Web dashboard listening on port ${port}`);
});
