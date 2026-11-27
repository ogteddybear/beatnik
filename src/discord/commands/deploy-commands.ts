import { config } from "@/core/config";
import { log } from "@/shared";
import { REST, Routes } from "discord.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { builder as autoplay } from "./autoplay/builder";
import { builder as clear } from "./clear/builder";
import { builder as diagnostics } from "./diagnostics/builder";
import { builder as history } from "./history/builder";
import { builder as add } from "./library/add/builder";
import { builder as load } from "./library/load/builder";
import { builder as libraryRemove } from "./library/remove/builder";
import { builder as update } from "./library/update/builder";
import { builder as live } from "./live/builder";
import { builder as lyrics } from "./lyrics/builder";
import { builder as play } from "./play/builder";
import { builder as queue } from "./queue/builder";
import { builder as remove } from "./remove/builder";
import { builder as shuffle } from "./shuffle/builder";
import { builder as skip } from "./skip/builder";
import { builder as coach } from "./special/coach/builder";
import { builder as spotify } from "./spotify/builder";
import { builder as stop } from "./stop/builder";
import { builder as storage } from "./storage/builder";
import { builder as volume } from "./volume/builder";

const COMMANDS_VERSION = "2.0.1";
const versionFile = path.join(config.libraryPath, ".commands-version");

async function shouldDeploy() {
  try {
    const deployedVersion = await readFile(versionFile, "utf-8");
    return deployedVersion.trim() !== COMMANDS_VERSION;
  } catch {
    return true; // file doesn't exist, deploy commands
  }
}

export async function deployCommands() {
  try {
    if (!(await shouldDeploy())) {
      log({
        component: "DISCORD",
        name: "COMMANDS",
        message: `Command version ${COMMANDS_VERSION} already deployed, skipping.`,
      });
      return;
    }
    const { token, clientId } = config.discord;
    const builders = [
      live,
      autoplay,
      diagnostics,
      add,
      load,
      play,
      queue,
      remove,
      shuffle,
      skip,
      stop,
      update,
      coach,
      volume,
      clear,
      storage,
      libraryRemove,
      history,
      lyrics,
      spotify,
    ];
    const builderDefs = builders.map((b) => b.toJSON());
    const rest = new REST().setToken(token);
    const data = await rest.put(Routes.applicationCommands(clientId), { body: builderDefs });
    const count = Array.isArray(data) ? `${data.length}` : "unknown";

    await writeFile(versionFile, COMMANDS_VERSION, "utf-8");

    log({
      component: "DISCORD",
      name: "COMMANDS",
      message: `Successfully registered ${count} global commands for Sashimi (command version ${COMMANDS_VERSION})`,
    });
  } catch (err) {
    console.error(err);
  }
}
