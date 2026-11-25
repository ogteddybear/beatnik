import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("pending invite rechecks membership without restarting OAuth or hiding errors", async () => {
  const dom = new JSDOM(
    `<h1 id="invite-title">Installation confirmation pending</h1>
    <p id="invite-message">Do not invite again</p><p id="invite-check-status"></p>
    <button id="invite-check">Check confirmation</button>`,
    { runScripts: "outside-only" },
  );
  const { window } = dom;
  let tick: () => void = () => {
    throw new Error("No interval");
  };
  let confirmed = false;
  let fail = false;
  let requests = 0;
  Object.defineProperty(window.document, "hidden", { value: false });
  window.setInterval = ((fn: () => void) => {
    tick = fn;
    return 1;
  }) as typeof window.setInterval;
  window.fetch = async (url) => {
    assert.equal(url, "/api/invite/status");
    requests++;
    if (fail) throw new Error("Offline");
    return Response.json({
      status: confirmed ? "confirmed" : "pending",
      canCheck: !confirmed,
      title: confirmed ? "Sashimi is in your server" : "Installation confirmation pending",
      message: confirmed ? "Installation confirmed." : "Do not invite again",
    });
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    window.eval(await readFile("src/web/public/invite-status.js", "utf8"));
    await flush();
    assert.equal(requests, 1);
    assert.match(window.document.getElementById("invite-title")?.textContent ?? "", /pending/);
    fail = true;
    tick();
    await flush();
    assert.match(
      window.document.getElementById("invite-check-status")?.textContent ?? "",
      /without repeating/,
    );
    assert.match(window.document.getElementById("invite-title")?.textContent ?? "", /pending/);
    fail = false;
    confirmed = true;
    window.document.querySelector("button")?.click();
    await flush();
    assert.match(
      window.document.getElementById("invite-title")?.textContent ?? "",
      /Sashimi is in your server/,
    );
    assert.equal(window.document.querySelector<HTMLButtonElement>("button")?.hidden, true);
    const before = requests;
    tick();
    await flush();
    assert.equal(requests, before);
  } finally {
    window.close();
  }
});
