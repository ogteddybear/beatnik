import express from "express";
import assert from "node:assert/strict";
import { test } from "node:test";

import { publishGuildUpdate } from "../core/live-updates";
import { mountEventsStream } from "./events-stream";

test("SSE sends private invalidations, reauthorizes and closes on revoked access", async () => {
  const app = express();
  let allowed = true;
  let checks = 0;
  mountEventsStream(
    app,
    async (req) => {
      checks++;
      return req.get("X-User") === "manager" && allowed
        ? { userId: "manager", guildIds: ["managed"] }
        : null;
    },
    60000,
  );
  const server = app.listen(0, "127.0.0.1");
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/events/stream`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { "X-User": "manager" }, signal: abort.signal });
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert(reader);
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /event: refresh/);
    const before = checks;
    publishGuildUpdate("private");
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(checks, before, "Unrelated guild events must not trigger notifications");
    publishGuildUpdate("managed");
    publishGuildUpdate("managed");
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.equal(update, "event: refresh\ndata: {}\n\n");
    assert.equal(checks, before + 1, "Bursts are coalesced");
    allowed = false;
    publishGuildUpdate("managed");
    assert.equal((await reader.read()).done, true);
    const after = checks;
    publishGuildUpdate("managed");
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.equal(checks, after, "Closed streams unsubscribe");
  } finally {
    abort.abort();
    server.closeAllConnections();
    server.close();
  }
});
