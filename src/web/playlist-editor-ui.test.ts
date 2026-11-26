import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("playlist editor safely renders tracks and wires rename, search, add, delete, import and drag", async () => {
  const html = await ejs.renderFile("src/web/views/playlist-editor.ejs", {
    playlist: { id: 1, name: "Playlist" },
    username: "User",
    avatarUrl: "",
    isAdmin: false,
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  let drag: ((event: { oldIndex: number; newIndex: number }) => void) | undefined;
  Object.assign(window, {
    Sortable: {
      create: (_element: unknown, options: { onEnd: typeof drag }) => {
        drag = options.onEnd;
      },
    },
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  window.fetch = async (url, options) => {
    const method = options?.method ?? "GET";
    assert.equal(new Headers(options?.headers).get("X-Sashimi-Request"), "playlists");
    calls.push({
      url: String(url),
      method,
      body: options?.body ? JSON.parse(String(options.body)) : null,
    });
    const tracks = [
      {
        title: "<script>Song</script>",
        channelName: "Artist",
        url: "https://youtu.be/song",
        playlistTrackId: 10,
      },
      { title: "Second", playlistTrackId: 11 },
    ];
    return Response.json(
      String(url).includes("/search/")
        ? { tracks: [tracks[0]] }
        : { playlist: { name: "Playlist", tracks } },
    );
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const submit = (id: string) =>
    window.document
      .getElementById(id)
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
  try {
    window.eval(await readFile("src/web/public/playlist-editor.js", "utf8"));
    await flush();
    assert.equal(window.document.querySelectorAll("#editor-tracks li").length, 2);
    assert.equal(window.document.querySelector("#editor-tracks script"), null);
    submit("rename-playlist");
    await flush();
    assert(calls.some((call) => call.method === "PUT"));
    submit("search-tracks");
    await flush();
    window.document.querySelector<HTMLButtonElement>("#search-results button")?.click();
    await flush();
    assert(calls.some((call) => call.url.endsWith("/tracks") && call.method === "POST"));
    const remove = [
      ...window.document.querySelectorAll<HTMLButtonElement>("#editor-tracks button"),
    ].find((button) => button.textContent === "Remove");
    assert(remove);
    remove.click();
    await flush();
    assert(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/tracks/10")));
    submit("spotify-import");
    await flush();
    assert(calls.some((call) => call.url.endsWith("/import/spotify")));
    assert(drag);
    drag({ oldIndex: 1, newIndex: 0 });
    await flush();
    assert(
      calls.some(
        (call) =>
          call.url.endsWith("/reorder") && JSON.stringify(call.body) === '{"trackIds":[11,10]}',
      ),
    );
  } finally {
    window.close();
  }
});
