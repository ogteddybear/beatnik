import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { proxyImageUrl } from "../utils/image-proxy";

const browserProxy = (url: string) =>
  "https://sashimi.example" + new URL(proxyImageUrl(url)).pathname;

for (const mode of ["admin", "regular"]) {
  test(`${mode} refresh preserves icons and card identity`, async () => {
    const guild = {
      id: "123",
      name: "Music server",
      iconUrl: "https://cdn.discordapp.com/icons/123/icon.png",
      plays: 1,
      requests: 2,
      storageUsed: "12 B",
      storageLimit: "100 MB",
      storagePercentage: 60,
      storageOverQuota: false,
      skips: 0,
      stops: 0,
      commands: 3,
      recent: { plays: 1, adds: 0, commands: 3, errors: 0 },
    };
    let guilds = [guild, { ...guild, id: "456", name: "Fallback", iconUrl: null }];
    const html = await ejs.renderFile(
      `src/web/views/${mode === "admin" ? "admin" : "dashboard"}.ejs`,
      {
        username: "Owner",
        avatarUrl: "",
        isAdmin: mode === "admin",
        inviteUrl: "/invite",
        guilds,
        proxyImageUrl,
      },
    );
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
    const initialCard = dom.window.document.querySelector('[data-guild-id="123"]');
    const initialIcon = initialCard?.querySelector("img");
    assert(initialIcon, "initial HTML includes guild icon");
    assert.equal(initialIcon.src, proxyImageUrl(guild.iconUrl));
    let tick: () => void = () => {
      throw new Error("Polling interval not registered");
    };
    dom.window.setInterval = ((callback: () => void) => {
      tick = callback;
      return 1;
    }) as typeof dom.window.setInterval;
    Object.defineProperty(dom.window.document, "hidden", { value: false });
    dom.window.fetch = async () => Response.json({ guilds });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      dom.window.eval(await readFile("src/web/public/dashboard-live.js", "utf8"));
      await flush();
      const document = dom.window.document;
      const card = document.querySelector('[data-guild-id="123"]');
      assert(card);
      const icon = card.querySelector("img");
      assert(icon, "guild icon must render after AJAX refresh");
      assert.equal(icon.src, browserProxy(guild.iconUrl));
      assert.equal(card, initialCard);
      assert.equal(card.querySelector<HTMLElement>(".progress-bar")?.style.width, "60%");
      assert.equal(icon, initialIcon);
      assert.match(
        document.querySelector('[data-guild-id="456"] .guild-placeholder')?.textContent || "",
        /F/,
      );
      for (let i = 0; i < 3; i++) {
        tick();
        await flush();
        assert.equal(document.querySelector('[data-guild-id="123"]'), card);
        assert.equal(card.querySelector("img"), icon);
      }
      guilds = [
        { ...guild, plays: 9, name: "Renamed", storagePercentage: 150, storageOverQuota: true },
      ];
      tick();
      await flush();
      assert.equal(document.querySelector('[data-guild-id="456"]'), null);
      assert.match(card.textContent || "", /Renamed/);
      assert.equal(card.querySelector('[data-stat="plays"]')?.textContent, "9");
      assert.equal(card.querySelector<HTMLElement>(".progress-bar")?.style.width, "100%");
      assert(card.querySelector(".progress-bar.bg-danger"));
      assert.match(
        card.querySelector("[data-storage-progress]")?.getAttribute("aria-valuetext") ?? "",
        /150%/,
      );
      guilds = [{ ...guild, iconUrl: "https://cdn.discordapp.com/icons/123/new.png" }];
      tick();
      await flush();
      assert.equal(icon.src, browserProxy(guilds[0].iconUrl ?? ""));
      icon.dispatchEvent(new dom.window.Event("error"));
      assert.equal(icon.hidden, true);
      assert.equal(card.querySelector<HTMLElement>(".guild-placeholder")?.hidden, false);
      guilds = [...guilds, { ...guild, id: "789", name: "New server" }];
      tick();
      await flush();
      assert.equal(
        document.querySelector<HTMLImageElement>('[data-guild-id="789"] img')?.src,
        browserProxy(guild.iconUrl),
      );
    } finally {
      dom.window.close();
    }
  });
}
