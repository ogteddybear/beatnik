import ejs from "ejs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("playlist page creates, lists, adds and deletes without rendering untrusted HTML", async () => {
  const html = await ejs.renderFile("src/web/views/playlists.ejs", {
    username: "User",
    avatarUrl: "",
    isAdmin: false,
  });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://sashimi.example" });
  const { window } = dom;
  const requests: { url: string; method: string; body: unknown }[] = [];
  let items = [
    { id: 1, name: "<script>Playlist</script>", tracks: [{ title: "<b>Song</b>", length: 90 }] },
  ];
  window.fetch = async (url, options) => {
    const method = options?.method ?? "GET";
    requests.push({
      url: String(url),
      method,
      body: options?.body ? JSON.parse(String(options.body)) : null,
    });
    if (method !== "GET")
      assert.equal(new Headers(options?.headers).get("X-Sashimi-Request"), "playlists");
    if (method === "DELETE") {
      items = [];
      return new Response(null, { status: 204 });
    }
    return Response.json({ playlists: items });
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/playlists.js", "utf8"));
    await flush();
    assert.equal(
      window.document.querySelector("#playlists h2")?.textContent,
      "<script>Playlist</script>",
    );
    assert.equal(window.document.querySelector("#playlists b"), null);
    const input = window.document.querySelector<HTMLInputElement>("#playlist-name");
    assert(input);
    input.value = "New";
    window.document
      .querySelector("#create-playlist")
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert(
      requests.some((request) => request.url === "/api/playlists" && request.method === "POST"),
    );
    const url = window.document.querySelector<HTMLInputElement>('#playlists input[type="url"]');
    assert(url);
    url.value = "https://youtu.be/example";
    window.document
      .querySelector("#playlists form")
      ?.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await flush();
    assert(
      requests.some(
        (request) => request.url === "/api/playlists/1/tracks" && request.method === "POST",
      ),
    );
    window.document.querySelector<HTMLButtonElement>("#playlists .btn-outline-danger")?.click();
    await flush();
    assert.match(
      window.document.getElementById("playlist-status")?.textContent ?? "",
      /No playlists/,
    );
  } finally {
    window.close();
  }
});
