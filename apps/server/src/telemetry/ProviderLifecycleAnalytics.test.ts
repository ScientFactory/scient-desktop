import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";

import { createProviderLifecycleAnalyticsMapper } from "./ProviderLifecycleAnalytics.ts";

function provider(operation: ProviderRuntimeOperation | null = null): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("private-name"),
    driver: ProviderDriverKind.make("droid"),
    enabled: true,
    installed: true,
    version: "0.200.0",
    status: "ready",
    auth: { status: "authenticated", email: "private@example.invalid" },
    checkedAt: "2026-08-31T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["droid_device_pairing"],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "0.200.0",
        previousManagedVersion: null,
        message: "private path /Users/private",
        operation,
      },
    },
  };
}

function operation(status: ProviderRuntimeOperation["status"]): ProviderRuntimeOperation {
  return {
    operationId: "private-operation-id",
    action: "repair",
    status,
    startedAt: "2026-08-31T00:00:00.000Z",
    finishedAt: status === "failed" ? "2026-08-31T00:00:12.000Z" : null,
    message: "private provider output",
  };
}

describe("Provider lifecycle analytics", () => {
  it("never measures the completion of a baseline running operation", () => {
    const mapper = createProviderLifecycleAnalyticsMapper();
    for (let epoch = 0; epoch < 2; epoch++) {
      mapper.clear();
      mapper.observe([provider(operation("downloading"))]);
      expect(mapper.observe([provider(operation("failed"))])).toEqual([]);
    }
  });
  it("records observed starts and one terminal outcome, never progress ticks or raw data", () => {
    const mapper = createProviderLifecycleAnalyticsMapper();
    mapper.observe([provider()]);
    expect(mapper.observe([provider(operation("preparing"))])).toMatchObject([
      { name: "provider.lifecycle.started", properties: { provider: "droid", action: "repair" } },
    ]);
    expect(mapper.observe([provider(operation("downloading"))])).toEqual([]);
    const failed = mapper.observe([provider(operation("failed"))]);
    expect(failed).toEqual([
      {
        name: "provider.lifecycle.failed",
        properties: {
          provider: "droid",
          action: "repair",
          source: "scient_managed",
          stage: "downloading",
          durationMs: 12_000,
          failureClass: "unknown",
        },
      },
    ]);
    expect(JSON.stringify(failed)).not.toContain("private");
    expect(mapper.observe([provider(operation("failed"))])).toEqual([]);
  });

  it("does not replay terminal or pre-consent operations as new successes or failures", () => {
    const mapper = createProviderLifecycleAnalyticsMapper();
    expect(mapper.observe([provider(operation("failed"))]).map((event) => event.name)).toEqual([
      "provider.discovered",
    ]);
    mapper.clear();
    expect(mapper.observe([provider(operation("failed"))]).map((event) => event.name)).toEqual([
      "provider.discovered",
    ]);
  });

  it("ignores provisional probes and observes source/readiness transitions without inferring sign-out", () => {
    const mapper = createProviderLifecycleAnalyticsMapper();
    expect(mapper.observe([{ ...provider(), probePending: true }])).toEqual([]);
    mapper.observe([provider()]);
    const { connection: _connection, ...withoutConnection } = provider();
    const missing = {
      ...withoutConnection,
      installed: false,
      status: "warning" as const,
    };
    expect(mapper.observe([missing])).toEqual([
      {
        name: "provider.readiness.changed",
        properties: { provider: "droid", from: "ready", to: "warning" },
      },
      {
        name: "provider.runtime.source.changed",
        properties: { provider: "droid", from: "scient_managed", to: "missing" },
      },
    ]);
  });
});
