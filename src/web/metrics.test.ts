import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatUptime,
  getFlyInfrastructureMetrics,
  getInfrastructureMetrics,
  getLocalSystemMetrics,
} from "./metrics";

test("infrastructure metrics isolate query failures, select the machine, and never return credentials", async () => {
  const saved = {
    token: process.env.FLY_API_TOKEN,
    org: process.env.FLY_ORG_SLUG,
    machine: process.env.FLY_MACHINE_ID,
    alloc: process.env.FLY_ALLOC_ID,
  };
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLY_ORG_SLUG;
    const noNetwork: typeof fetch = async () => {
      throw new Error("Should not fetch without credentials");
    };
    assert.deepEqual(await getFlyInfrastructureMetrics(noNetwork), {
      totalMemoryBytes: null,
      volumeTotalBytes: null,
      volumeFreeBytes: null,
    });
    process.env.FLY_API_TOKEN = "metrics-test-secret";
    process.env.FLY_ORG_SLUG = "test-org";
    process.env.FLY_MACHINE_ID = "my-machine";
    delete process.env.FLY_ALLOC_ID;
    const vector = (values: { metric: Record<string, string>; value: [number, string] }[]) =>
      Response.json({ status: "success", data: { resultType: "vector", result: values } });
    const sample = (value: string, machine = "my-machine") => ({
      metric: { instance: machine },
      value: [1, value] as [number, string],
    });
    for (const [token, expected] of [
      ["fm2_test-macaroon", "FlyV1 fm2_test-macaroon"],
      ["FlyV1 fm2_test-macaroon", "FlyV1 fm2_test-macaroon"],
      ["fo1_test-legacy", "Bearer fo1_test-legacy"],
    ]) {
      process.env.FLY_API_TOKEN = token;
      const headers: (string | null)[] = [];
      const authFetcher: typeof fetch = async (_url, options) => {
        headers.push(new Headers(options?.headers).get("Authorization"));
        return vector([sample("123")]);
      };
      const metrics = await getFlyInfrastructureMetrics(authFetcher);
      assert.deepEqual(headers, [expected, expected, expected]);
      assert.equal(metrics.totalMemoryBytes, 123);
    }
    process.env.FLY_API_TOKEN = "metrics-test-secret";
    const queries: string[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      const endpoint = new URL(String(url));
      assert.equal(endpoint.origin, "https://api.fly.io");
      assert.equal(endpoint.pathname, "/prometheus/test-org/api/v1/query");
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        "Bearer metrics-test-secret",
      );
      assert(options?.signal);
      assert.equal(options?.redirect, "error");
      const query = endpoint.searchParams.get("query") ?? "";
      queries.push(query);
      if (query.startsWith("fly_instance"))
        return vector([sample("999", "other"), sample("1073741824")]);
      if (query.startsWith("fly_volume_size")) return vector([sample("21474836480")]);
      return new Response("private server failure details", { status: 503 });
    };
    assert.deepEqual(await getFlyInfrastructureMetrics(fetcher), {
      totalMemoryBytes: 1073741824,
      volumeTotalBytes: 21474836480,
      volumeFreeBytes: null,
    });
    assert.equal(queries.length, 3);
    const bad: typeof fetch = async () => vector([sample("NaN")]);
    assert.equal((await getFlyInfrastructureMetrics(bad)).totalMemoryBytes, null);
    const wrongMachine: typeof fetch = async () => vector([sample("123", "other")]);
    assert.equal((await getFlyInfrastructureMetrics(wrongMachine)).totalMemoryBytes, null);
    delete process.env.FLY_MACHINE_ID;
    const ambiguous: typeof fetch = async () => vector([sample("1", "a"), sample("2", "b")]);
    assert.equal((await getFlyInfrastructureMetrics(ambiguous)).volumeTotalBytes, null);
    const malformed: typeof fetch = async () =>
      Response.json({ status: "success", data: { result: [] } });
    assert.equal((await getFlyInfrastructureMetrics(malformed)).volumeFreeBytes, null);
    const timedOut: typeof fetch = async () => {
      throw new DOMException("timeout", "TimeoutError");
    };
    assert.equal((await getFlyInfrastructureMetrics(timedOut)).totalMemoryBytes, null);
    process.env.FLY_ORG_SLUG = "../bad";
    assert.equal((await getFlyInfrastructureMetrics(noNetwork)).totalMemoryBytes, null);
    process.env.FLY_ORG_SLUG = "test-org";
    process.env.FLY_MACHINE_ID = "my-machine";
    queries.length = 0;
    globalThis.fetch = fetcher;
    const [first, second] = await Promise.all([
      getInfrastructureMetrics(),
      getInfrastructureMetrics(),
    ]);
    assert.equal(queries.length, 3, "Concurrent callers share the platform request");
    assert.equal(first.memory.text.includes("GB"), true);
    assert.equal(
      first.volume,
      null,
      "Do not combine platform total with local filesystem free space",
    );
    assert.equal(second.volume, null);
    assert.doesNotMatch(
      JSON.stringify(first),
      /metrics-test-secret|test-org|Authorization|private server/,
    );
    const local = await getLocalSystemMetrics();
    assert(local.rssBytes > 0);
    assert(local.uptimeSeconds >= 0);
    assert.equal(local.loadAverage.length, 3);
    assert.equal(formatUptime(3 * 86400 + 4 * 3600 + 12 * 60), "3d 4h 12m");
    if (process.platform === "win32") assert.equal(local.cpuPercent, null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      FLY_API_TOKEN: saved.token,
      FLY_ORG_SLUG: saved.org,
      FLY_MACHINE_ID: saved.machine,
      FLY_ALLOC_ID: saved.alloc,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});
