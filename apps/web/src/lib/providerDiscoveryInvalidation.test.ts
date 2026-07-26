// FILE: providerDiscoveryInvalidation.test.ts
// Purpose: Verifies provider-discovery invalidation ignores provider-status metadata noise.
// Layer: Web UI provider discovery tests

import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  AUTH_SENSITIVE_AGENT_DISCOVERY_PROVIDERS,
  getProviderDiscoveryGeneration,
  providerModelDiscoveryInvalidationFingerprint,
  setProviderDiscoveryGeneration,
} from "./providerDiscoveryInvalidation";

const BASE_PROVIDER_STATUS = {
  provider: "cursor",
  status: "ready",
  available: true,
  authStatus: "unknown",
  version: "2026.06.04-8f81907",
  checkedAt: "2026-06-04T10:00:00.000Z",
  message:
    "Cursor Agent CLI is installed. Sign in with Cursor if a session prompts for authentication.",
  versionAdvisory: {
    status: "current",
    currentVersion: "2026.06.04-8f81907",
    latestVersion: "2026.06.04-8f81907",
    updateCommand: null,
    canUpdate: true,
    checkedAt: "2026-06-04T10:00:00.000Z",
    message: null,
  },
} satisfies ServerProviderStatus;

describe("providerModelDiscoveryInvalidationFingerprint", () => {
  it("refreshes Claude agent discovery with other auth-sensitive agent catalogs", () => {
    expect(AUTH_SENSITIVE_AGENT_DISCOVERY_PROVIDERS).toContain("claudeAgent");
  });

  it("keeps repeated fingerprints stable while issuing opaque generations for A-B-A", () => {
    const firstFingerprint = `${providerModelDiscoveryInvalidationFingerprint([
      BASE_PROVIDER_STATUS,
    ])}:first`;
    const secondFingerprint = `${firstFingerprint}:second`;

    const firstGeneration = setProviderDiscoveryGeneration(firstFingerprint);
    expect(setProviderDiscoveryGeneration(firstFingerprint)).toBe(firstGeneration);

    const secondGeneration = setProviderDiscoveryGeneration(secondFingerprint);
    expect(secondGeneration).not.toBe(firstGeneration);

    const returnedGeneration = setProviderDiscoveryGeneration(firstFingerprint);
    expect(returnedGeneration).not.toBe(firstGeneration);
    expect(returnedGeneration).not.toBe(secondGeneration);
    expect(getProviderDiscoveryGeneration()).toBe(returnedGeneration);
    expect(returnedGeneration).not.toContain(firstFingerprint);
  });

  it("ignores provider checkedAt, message, and advisory metadata churn", () => {
    expect(
      providerModelDiscoveryInvalidationFingerprint([
        {
          ...BASE_PROVIDER_STATUS,
          checkedAt: "2026-06-04T10:05:00.000Z",
          message: "Cursor Agent CLI is still installed.",
          versionAdvisory: {
            ...BASE_PROVIDER_STATUS.versionAdvisory,
            checkedAt: "2026-06-04T10:05:00.000Z",
            message: "Checked just now.",
          },
        },
      ]),
    ).toBe(providerModelDiscoveryInvalidationFingerprint([BASE_PROVIDER_STATUS]));
  });

  it("changes when model discovery inputs can change", () => {
    const previous = providerModelDiscoveryInvalidationFingerprint([BASE_PROVIDER_STATUS]);

    expect(
      providerModelDiscoveryInvalidationFingerprint([
        {
          ...BASE_PROVIDER_STATUS,
          authStatus: "authenticated",
          authLabel: "pro@example.com",
        },
      ]),
    ).not.toBe(previous);

    expect(
      providerModelDiscoveryInvalidationFingerprint([
        {
          ...BASE_PROVIDER_STATUS,
          version: "2026.06.05-a1b2c3d",
        },
      ]),
    ).not.toBe(previous);
  });

  it("is stable across provider ordering", () => {
    const codexStatus = {
      ...BASE_PROVIDER_STATUS,
      provider: "codex",
      version: "1.2.3",
    } satisfies ServerProviderStatus;

    expect(providerModelDiscoveryInvalidationFingerprint([BASE_PROVIDER_STATUS, codexStatus])).toBe(
      providerModelDiscoveryInvalidationFingerprint([codexStatus, BASE_PROVIDER_STATUS]),
    );
  });
});
