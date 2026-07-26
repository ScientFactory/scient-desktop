// FILE: packagedStartupResponsiveness.ts
// Purpose: Waits for delayed packaged-startup proof to observe a semantically ready backend.
// Layer: Desktop startup utility
// Exports: waitForPackagedBackendResponsiveness

import { waitForHttpReady } from "./backendReadiness";

const PACKAGED_RESPONSIVENESS_TIMEOUT_MS = 30_000;

export interface PackagedBackendResponsivenessOptions {
  readonly fetchImpl?: typeof fetch;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export async function waitForPackagedBackendResponsiveness(
  baseUrl: string,
  options?: PackagedBackendResponsivenessOptions,
): Promise<void> {
  await waitForHttpReady(baseUrl, {
    path: "/health",
    timeoutMs: options?.timeoutMs ?? PACKAGED_RESPONSIVENESS_TIMEOUT_MS,
    ...(options?.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    isReady: async (response) => {
      if (!response.ok) return false;
      try {
        const payload = (await response.json()) as { startupReady?: unknown };
        return payload.startupReady === true;
      } catch {
        return false;
      }
    },
  });
}
