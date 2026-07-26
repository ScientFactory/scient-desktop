// FILE: providerDiscoveryInvalidation.ts
// Purpose: Keeps provider-discovery cache invalidation tied to meaningful provider changes.
// Layer: Web UI provider discovery
// Exports: providerModelDiscoveryInvalidationFingerprint

import type { ServerProviderStatus } from "@synara/contracts";

// The fingerprint may contain account labels and, unlike a generation, can repeat
// after an A -> B -> A auth transition. Keep it renderer-local for change detection
// and expose only an opaque, never-reused ownership token to query keys and RPC.
const providerDiscoveryRendererNonce = globalThis.crypto.randomUUID();
let providerDiscoveryFingerprint: string | null = null;
let providerDiscoveryEpoch = 0;
let providerDiscoveryGeneration = `${providerDiscoveryRendererNonce}:0`;

export const AUTH_SENSITIVE_AGENT_DISCOVERY_PROVIDERS = [
  "claudeAgent",
  "kilo",
  "opencode",
] as const;

/**
 * Bind server-side in-flight discovery ownership to the provider status generation
 * that initiated it. A later auth/runtime generation must never join an older CLI.
 */
export function setProviderDiscoveryGeneration(fingerprint: string): string {
  if (fingerprint !== providerDiscoveryFingerprint) {
    providerDiscoveryFingerprint = fingerprint;
    providerDiscoveryEpoch += 1;
    providerDiscoveryGeneration = `${providerDiscoveryRendererNonce}:${providerDiscoveryEpoch}`;
  }
  return providerDiscoveryGeneration;
}

export function getProviderDiscoveryGeneration(): string {
  return providerDiscoveryGeneration;
}

type ProviderModelDiscoveryFingerprintEntry = readonly [
  provider: ServerProviderStatus["provider"],
  status: ServerProviderStatus["status"],
  available: boolean,
  authStatus: ServerProviderStatus["authStatus"],
  authType: string | null,
  authLabel: string | null,
  version: string | null,
];

export function providerModelDiscoveryInvalidationFingerprint(
  providers: ReadonlyArray<ServerProviderStatus>,
): string {
  const entries = providers
    .map(
      (provider): ProviderModelDiscoveryFingerprintEntry => [
        provider.provider,
        provider.status,
        provider.available,
        provider.authStatus,
        provider.authType ?? null,
        provider.authLabel ?? null,
        provider.version ?? null,
      ],
    )
    .toSorted((left, right) => left[0].localeCompare(right[0]));

  return JSON.stringify(entries);
}
