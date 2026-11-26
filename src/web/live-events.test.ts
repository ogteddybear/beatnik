import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("live transport uses SSE, falls back during errors and clears polling on reconnection", async () => {
  const dom = new JSDOM("", { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  let refreshEvent: (() => void) | undefined;
  let source: FakeSource | undefined;
  let polls = 0,
    cleared = 0,
    refreshes = 0;
  class FakeSource {
    onopen?: () => void;
    onerror?: () => void;
    closed = false;
    constructor(url: string) {
      assert.equal(url, "/api/events/stream");
    }
    addEventListener(name: string, listener: () => void) {
      assert.equal(name, "refresh");
      refreshEvent = listener;
    }
    close() {
      this.closed = true;
    }
  }
  Object.assign(window, {
    EventSource: function (url: string) {
      source = new FakeSource(url);
      return source;
    },
    setInterval: () => {
      polls++;
      return 42;
    },
    clearInterval: () => {
      cleared++;
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
  });
  try {
    window.eval(await readFile("src/web/public/live-events.js", "utf8"));
    const start: unknown = window.eval("window.sashimiLive");
    assert(typeof start === "function");
    const close = start(() => {
      refreshes++;
    });
    assert(source);
    assert.equal(polls, 0);
    source.onerror?.();
    source.onerror?.();
    assert.equal(polls, 1);
    source.onopen?.();
    assert.equal(cleared, 1);
    refreshEvent?.();
    assert(refreshes > 0);
    close();
    assert.equal(source.closed, true);
    Object.assign(window, { EventSource: undefined });
    start(() => {
      refreshes++;
    });
    assert.equal(polls, 2);
  } finally {
    window.close();
  }
});
