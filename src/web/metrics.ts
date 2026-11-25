import { statfs } from "node:fs/promises";
import os from "node:os";

export async function getLocalSystemMetrics() {
  const loadAverage = os.loadavg();
  const coreCount = os.cpus().length;
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const fs = await statfs("/data");
    disk = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
  } catch {
    // /data may not exist in development, or statfs may not be supported.
  }
  return {
    rssBytes: process.memoryUsage().rss,
    loadAverage,
    coreCount,
    // Windows always returns zero load averages, not a measured idle CPU.
    cpuPercent:
      process.platform === "win32" || !coreCount ? null : (loadAverage[0] / coreCount) * 100,
    uptimeSeconds: process.uptime(),
    disk,
  };
}

export interface FlyInfrastructureMetrics {
  totalMemoryBytes: number | null;
  volumeTotalBytes: number | null;
  volumeFreeBytes: number | null;
}

async function queryFlyMetric(query: string, fetcher: typeof fetch): Promise<number | null> {
  const token = process.env.FLY_API_TOKEN || "";
  const org = process.env.FLY_ORG_SLUG;
  // Validate the path segment; it must not change the destination or URL path.
  if (!token || !org || !/^[a-zA-Z0-9_-]+$/.test(org)) return null;
  let authHeader = "";
  if (token.startsWith("FlyV1 ")) {
    authHeader = token;
  } else if (token.startsWith("fm2_")) {
    authHeader = `FlyV1 ${token}`;
  } else {
    // Fallback for legacy tokens.
    authHeader = `Bearer ${token}`;
  }
  const url = new URL(`https://api.fly.io/prometheus/${encodeURIComponent(org)}/api/v1/query`);
  url.searchParams.set("query", query);
  try {
    const response = await fetcher(url, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    const result = body as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
    if (
      result.status !== "success" ||
      result.data?.resultType !== "vector" ||
      !Array.isArray(result.data.result)
    )
      return null;
    const samples = result.data.result as { metric?: Record<string, string>; value?: unknown[] }[];
    const machineId = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID;
    const matching = machineId
      ? samples.filter((sample) =>
          [sample.metric?.instance, sample.metric?.machine_id, sample.metric?.alloc_id].includes(
            machineId,
          ),
        )
      : [];
    // Never sum other machines/volumes or pick an arbitrary org-wide series.
    const hasMachineLabels = samples.some(
      (sample) => sample.metric?.instance || sample.metric?.machine_id || sample.metric?.alloc_id,
    );
    const candidates = machineId && hasMachineLabels ? matching : samples;
    if (candidates.length !== 1) return null;
    const raw = candidates[0]?.value?.[1];
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    // Do not log fetch errors, headers or API bodies: these can contain secrets.
    return null;
  }
}

export async function getFlyInfrastructureMetrics(
  fetcher: typeof fetch = fetch,
): Promise<FlyInfrastructureMetrics> {
  const [totalMemoryBytes, volumeTotalBytes, volumeFreeBytes] = await Promise.all([
    queryFlyMetric('fly_instance_memory_mem_total{app="ogteddybear-beatnik"}', fetcher),
    queryFlyMetric('fly_volume_size_bytes{volume_name="beatnik_data"}', fetcher),
    queryFlyMetric('fly_volume_free_bytes{volume_name="beatnik_data"}', fetcher),
  ]);
  return { totalMemoryBytes, volumeTotalBytes, volumeFreeBytes };
}

export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][exponent]}`;
}

function meter(used: number, total: number | null) {
  const percentage = total !== null && total > 0 ? (used / total) * 100 : null;
  return {
    text: `${formatBytes(used)} / ${total === null ? "Unavailable" : formatBytes(total)}`,
    percentage,
  };
}

// Share the bounded platform request across concurrent page loads and polls.
let flyCache: { expires: number; pending: Promise<FlyInfrastructureMetrics> } | undefined;
export async function getInfrastructureMetrics() {
  if (!flyCache || Date.now() >= flyCache.expires) {
    flyCache = { expires: Date.now() + 15_000, pending: getFlyInfrastructureMetrics() };
  }
  const [local, fly] = await Promise.all([getLocalSystemMetrics(), flyCache.pending]);
  const total = fly.volumeTotalBytes ?? local.disk?.totalBytes ?? null;
  // Never combine a platform total with a different filesystem's free space.
  const free =
    fly.volumeTotalBytes !== null ? fly.volumeFreeBytes : (local.disk?.freeBytes ?? null);
  const volume =
    total !== null && free !== null && free <= total ? meter(total - free, total) : null;
  return {
    uptime: formatUptime(local.uptimeSeconds),
    memory: meter(local.rssBytes, fly.totalMemoryBytes),
    cpu:
      local.cpuPercent === null
        ? null
        : {
            text: `${local.cpuPercent.toFixed(1)}%`,
            percentage: local.cpuPercent,
          },
    loadAverage: local.loadAverage.map((value) => value.toFixed(2)).join(" / "),
    coreCount: local.coreCount,
    volume,
    volumeSource:
      fly.volumeTotalBytes !== null
        ? "Fly Prometheus"
        : local.disk
          ? "Local /data filesystem"
          : "Unavailable",
  };
}
