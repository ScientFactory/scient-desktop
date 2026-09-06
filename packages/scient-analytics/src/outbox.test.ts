// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Focused priority and batching tests for the worker-owned outbox.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { AnalyticsEvent, AnalyticsPriority } from "./contract.ts";
import { normalizeInheritedEvent } from "./contract.ts";
import { AnalyticsOutbox } from "./outbox.ts";

const fixtures: string[] = [];

function fixturePath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-outbox-"));
  fixtures.push(root);
  return NodePath.join(root, "outbox.sqlite");
}

function event(name: string): AnalyticsEvent {
  const normalized = normalizeInheritedEvent(
    name,
    {},
    { appVersion: "0.6.8", buildChannel: "stable" },
  );
  if (!normalized) throw new Error("Test requires a registered event");
  return {
    id: NodeCrypto.randomUUID(),
    name,
    distinct_id: `installation:${NodeCrypto.randomUUID()}`,
    session_id: `session:${NodeCrypto.randomUUID()}`,
    occurred_at: new Date().toISOString(),
    privacy_level: normalized.privacyLevel,
    consent_level: normalized.privacyLevel,
    properties: normalized.properties,
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("AnalyticsOutbox", () => {
  it("preserves numeric insight events and retry identity across restart without duplicating", () => {
    const path = fixturePath();
    const normalized = normalizeInheritedEvent(
      "provider.turn.usage",
      {
        provider: "codex",
        usageStatus: "complete",
        inputTokens: 12345,
        outputTokens: 678,
        cachedInputTokens: 200,
      },
      { appVersion: "0.6.10", buildChannel: "stable" },
    )!;
    const usage = { ...event("provider.turn.usage"), properties: normalized.properties };
    const first = new AnalyticsOutbox(path);
    expect(first.enqueue(usage)).toBe(true);
    expect(first.enqueue(usage)).toBe(false);
    first.markFailed([usage.id], "network", 0);
    first.close();
    const reopened = new AnalyticsOutbox(path);
    const pending = reopened.pending(50, Date.now());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: usage.id,
      attemptCount: 1,
      properties: { inputTokens: 12345, outputTokens: 678, cachedInputTokens: 200 },
    });
    reopened.close();
  });
  it("writes a coalesced batch transaction and delivers critical events first", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const events = [event("surface.opened"), event("app.health"), event("project.opened")];
    const priorities: AnalyticsPriority[] = ["summary", "critical", "core"];

    expect(outbox.enqueueBatch(events, priorities)).toBe(3);
    expect(outbox.pending(3, Date.now()).map((pending) => pending.name)).toEqual([
      "app.health",
      "project.opened",
      "surface.opened",
    ]);
    outbox.close();
  });

  it("keeps its in-memory count correct when a batch transaction rolls back", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const valid = event("project.opened");
    const invalid = {
      ...event("project.opened"),
      properties: { unserializable: 1n },
    } as unknown as AnalyticsEvent;
    expect(() => outbox.enqueueBatch([valid, invalid], ["core", "core"])).toThrow();
    expect(outbox.size()).toBe(0);
    expect(outbox.pending(10, Date.now())).toEqual([]);
    expect(outbox.enqueue(valid)).toBe(true);
    expect(outbox.size()).toBe(1);
    outbox.close();
  });

  it("keeps critical events when trimming a full outbox", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const events = Array.from({ length: 10_001 }, () => event("surface.opened"));
    outbox.enqueueBatch(
      events,
      events.map(() => "summary"),
    );
    outbox.enqueueBatch([event("app.health")], ["critical"]);
    expect(outbox.size()).toBe(10_000);
    expect(outbox.pending(1, Date.now())[0]?.name).toBe("app.health");
    outbox.close();
  });

  it("quarantines forbidden persisted properties and retires expired or exhausted rows", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const now = Date.now();
    const safe = event("app.health");
    const injected = {
      ...event("app.health"),
      properties: { ...safe.properties, prompt: "PRIVATE-CONTENT" },
    };
    const old = {
      ...event("app.health"),
      occurred_at: new Date(now - 181 * 86400000).toISOString(),
    };
    const diagnostic = {
      ...event("app.diagnostics"),
      occurred_at: new Date(now - 31 * 86400000).toISOString(),
    };
    const exhausted = event("app.health");
    outbox.enqueueBatch(
      [safe, injected, old, diagnostic, exhausted],
      Array.from({ length: 5 }, () => "core"),
    );
    for (let i = 0; i < 20; i += 1) outbox.markFailed([exhausted.id], "network", 0);
    expect(outbox.pending(50, now).map((entry) => entry.id)).toEqual([safe.id]);
    expect(outbox.size()).toBe(1);
    outbox.close();
  });
});
