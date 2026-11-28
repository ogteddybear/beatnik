import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Tidal token refresh, revocation and JSON:API pagination are isolated and safe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-tidal-api-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    TIDAL_CLIENT_ID: "client",
    TIDAL_CLIENT_SECRET: "secret",
    TIDAL_COUNTRY_CODE: "US",
  });
  const { db, archiveDb } = await import("../../core/db/client");
  const { tidalUsers } = await import("../../core/db/tidal-users");
  const { getValidTidalAccessToken } = await import("./tokens");
  const { getUserPlaylists, getPlaylistTracks } = await import("./api");
  const { TidalNotLinkedError, TidalApiError } = await import("./errors");
  const original = globalThis.fetch;
  const row = (id: string, expires = 0) => ({
    discord_user_id: id,
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    expires_at: expires,
    tidal_user_id: id,
    tidal_display_name: id,
    updated_at: Date.now(),
  });
  try {
    assert.equal(await getValidTidalAccessToken("missing"), null);
    await assert.rejects(getUserPlaylists("missing"), TidalNotLinkedError);
    tidalUsers.save(row("A"));
    tidalUsers.save(row("B", Date.now() + 3600_000));
    let calls = 0;
    let release!: (response: Response) => void;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        `Basic ${Buffer.from("client:secret").toString("base64")}`,
      );
      assert.equal(new URLSearchParams(String(options?.body)).get("refresh_token"), "refresh-A");
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const first = getValidTidalAccessToken("A");
    const second = getValidTidalAccessToken("A");
    assert.equal(calls, 1);
    assert.equal(await getValidTidalAccessToken("B"), "access-B");
    release(
      Response.json({ access_token: "fresh-A", refresh_token: "rotated-A", expires_in: 3600 }),
    );
    assert.deepEqual(await Promise.all([first, second]), ["fresh-A", "fresh-A"]);
    assert.equal(tidalUsers.get("A")?.refresh_token, "rotated-A");
    assert.equal(tidalUsers.get("B")?.access_token, "access-B");

    tidalUsers.save(row("A"));
    const unlinked = getValidTidalAccessToken("A");
    tidalUsers.unlink("A");
    release(Response.json({ access_token: "late", expires_in: 3600 }));
    await assert.rejects(unlinked, TidalNotLinkedError);
    assert.equal(tidalUsers.get("A"), undefined);
    tidalUsers.save(row("A"));
    const stale = getValidTidalAccessToken("A");
    tidalUsers.save({ ...row("A", Date.now() + 3600_000), access_token: "new-account" });
    release(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await assert.rejects(stale, TidalNotLinkedError);
    assert.equal(tidalUsers.get("A")?.access_token, "new-account");

    tidalUsers.save(row("A"));
    globalThis.fetch = async () => new Response("", { status: 503 });
    await assert.rejects(getValidTidalAccessToken("A"), TidalApiError);
    assert(tidalUsers.get("A"));
    globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await assert.rejects(getValidTidalAccessToken("A"), TidalNotLinkedError);
    assert.equal(tidalUsers.get("A"), undefined);
    tidalUsers.save(row("A"));
    globalThis.fetch = async () => Response.json({ access_token: "renewed", expires_in: 3600 });
    assert.equal(await getValidTidalAccessToken("A"), "renewed");
    assert.equal(tidalUsers.get("A")?.refresh_token, "refresh-A");

    const seen: URL[] = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      seen.push(url);
      assert.equal(url.origin, "https://openapi.tidal.com");
      assert.equal(url.searchParams.get("countryCode"), "US");
      assert.equal(url.searchParams.get("filter[owners.id]"), "me");
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer renewed");
      assert.equal(new Headers(options?.headers).get("Accept"), "application/vnd.api+json");
      const cursor = url.searchParams.get("page[cursor]");
      if (!cursor)
        return Response.json({
          data: [
            {
              type: "playlists",
              id: "one",
              attributes: { name: "Private A", numberOfTrackItems: 21 },
            },
          ],
          links: { next: { href: "?filter[owners.id]=me&page[cursor]=second" } },
        });
      if (cursor === "second")
        return Response.json({
          data: [
            { type: "playlists", id: "two", attributes: { name: "Second", numberOfItems: 2 } },
          ],
          links: { next: "/v2/playlists?filter[owners.id]=me&page[cursor]=last" },
        });
      return Response.json({
        data: [{ type: "playlists", id: "three", attributes: { name: "Last" } }],
        links: { next: null },
      });
    };
    assert.deepEqual(await getUserPlaylists("A"), [
      { id: "one", name: "Private A", trackCount: 21 },
      { id: "two", name: "Second", trackCount: 2 },
      { id: "three", name: "Last", trackCount: 0 },
    ]);
    assert.equal(seen.length, 3);
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v2/playlists/one/relationships/items");
      assert.equal(url.searchParams.get("countryCode"), "US");
      if (url.searchParams.has("page[cursor]"))
        return Response.json({
          data: [{ type: "tracks", id: "t1" }],
          included: [
            { type: "tracks", id: "t1", attributes: { title: "Repeat", duration: "PT90S" } },
          ],
        });
      assert.equal(url.searchParams.get("include"), "items,items.tracks:artists");
      return Response.json({
        data: [
          { type: "tracks", id: "t1" },
          { type: "videos", id: "v1" },
          { type: "tracks", id: "unavailable" },
        ],
        included: [
          {
            type: "tracks",
            id: "t1",
            attributes: { title: "Song", duration: "PT1H2M3.5S" },
            relationships: {
              artists: {
                data: [
                  { type: "artists", id: "a1" },
                  { type: "artists", id: "a2" },
                ],
              },
            },
          },
          { type: "artists", id: "a1", attributes: { name: "Artist 1" } },
          { type: "artists", id: "a2", attributes: { name: "Artist 2" } },
        ],
        links: { next: "?page[cursor]=next" },
      });
    };
    assert.deepEqual(await getPlaylistTracks("A", "one"), [
      { trackId: "t1", title: "Song", artist: "Artist 1, Artist 2", duration: 3723.5 },
      { trackId: "t1", title: "Repeat", artist: "", duration: 90 },
    ]);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ data: [], links: { next: "https://evil.example/steal" } });
    };
    await assert.rejects(getUserPlaylists("A"), TidalApiError);
    assert.equal(requests, 1, "Never send credentials to a pagination-supplied origin");
    globalThis.fetch = async () =>
      Response.json({
        data: [],
        links: { next: "/v2/playlists?filter[owners.id]=me" },
      });
    await assert.rejects(getUserPlaylists("A"), TidalApiError);
    globalThis.fetch = async () => Response.json({ nope: true });
    await assert.rejects(getUserPlaylists("A"), TidalApiError);

    let apiCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).includes("/oauth2/token"))
        return Response.json({ access_token: "retried", expires_in: 3600 });
      apiCalls++;
      return apiCalls === 1 ? new Response("", { status: 401 }) : Response.json({ data: [] });
    };
    assert.deepEqual(await getUserPlaylists("A"), []);
    assert.equal(apiCalls, 2);
    globalThis.fetch = async (input) =>
      String(input).includes("/oauth2/token")
        ? Response.json({ access_token: "still-revoked", expires_in: 3600 })
        : new Response("", { status: 401 });
    await assert.rejects(getUserPlaylists("A"), TidalNotLinkedError);
    assert.equal(tidalUsers.get("A"), undefined);
    assert(tidalUsers.get("B"));
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
