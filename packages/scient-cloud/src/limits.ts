import type { CloudLimits } from "./api.ts";

const MiB = 1024 * 1024;

/** Used only when `GET /v1/limits` cannot be read; the Worker's configured values win. */
export const DEFAULT_CLOUD_LIMITS = {
  freeBytes: 1024 * MiB,
  maxSnapshotBytes: 64 * MiB,
  maxBlobBytes: 25 * MiB,
  maxThreads: 10_000,
} as const satisfies CloudLimits;
