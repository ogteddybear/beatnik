import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("guild management UI saves settings, renders safe full queues, deletes and drags with revision checks", async () => {
  const html = await ejs.renderFile("src/web/views/guild-manage.ejs", {
    username: "Manager",
    avatarUrl: "",
    isAdmin: false,
    guildId: "guild",
    guildName: "Guild",
  });
  const dom = new JSDOM(html, {
    url: "https://sashimi.example",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  interface SortableOptions {
    handle: string;
    onStart(): void;
    onEnd(event: { oldIndex: number; newIndex: number }): void;
  }
  let sortable: SortableOptions | undefined;
  Object.assign(window, {
    Sortable: {
      create: (_element: unknown, options: SortableOptions) => {
        sortable = options;
      },
    },
  });
  const requests: { path: string; method: string; body: unknown }[] = [];
  const snapshot = {
    revision: "v1",
    loading: false,
    tracks: [
      { position: 1, title: "<script>Song</script>", artist: "<b>Artist</b>", current: true },
      { position: 2, title: "Next", artist: "Artist", current: false },
    ],
  };
  window.fetch = async (url, options) => {
    const pathname = String(url);
    const method = options?.method ?? "GET";
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : null;
    requests.push({ path: pathname, method, body });
    assert.equal(new Headers(options?.headers).get("X-Sashimi-Request"), "guild");
    if (pathname.endsWith("/settings"))
      return Response.json({ volume: 40, autoplay_enabled: true, dj_role_id: null });
    if (method !== "GET") assert.equal(new Headers(options?.headers).get("X-Queue-Revision"), "v1");
    return Response.json(snapshot);
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/guild-manage.js", "utf8"));
    await flush();
    assert.equal(window.document.querySelectorAll("#full-queue li").length, 2);
    assert.equal(window.document.querySelector("#full-queue script"), null);
    assert.match(
      window.document.querySelector("#full-queue")?.textContent ?? "",
      /<script>Song<\/script>/,
    );
    const volume = window.document.querySelector<HTMLInputElement>("#volume");
    assert(volume);
    assert.equal(volume.value, "40");
    volume.value = "65";
    const form = window.document.querySelector("#guild-settings");
    assert(form);
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/settings") &&
          JSON.stringify(request.body) ===
            JSON.stringify({ volume: 65, autoplay_enabled: true, dj_role_id: null }),
      ),
    );
    const remove = window.document.querySelector<HTMLButtonElement>(
      '#full-queue button[aria-label^="Remove"]',
    );
    assert(remove);
    remove.click();
    await flush();
    assert(
      requests.some((request) => request.method === "DELETE" && request.path.endsWith("/queue/1")),
    );
    assert(sortable);
    assert.equal(sortable.handle, ".queue-drag-handle");
    sortable.onStart();
    sortable.onEnd({ oldIndex: 1, newIndex: 0 });
    await flush();
    assert(
      requests.some(
        (request) =>
          request.path.endsWith("/queue/reorder") &&
          JSON.stringify(request.body) === '{"from":2,"to":1}',
      ),
    );
    assert.match(window.document.querySelector("#queue-status")?.textContent ?? "", /updated/);
  } finally {
    window.close();
  }
});
