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
    occurred_at: "2026-10-20T00:00:00.000Z",
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
    first.markAttempted([usage.id], "network");
    first.close();
    const reopened = new AnalyticsOutbox(path);
    const pending = reopened.pending(50, Date.parse("2026-10-20T00:00:00.000Z"));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: usage.id,
      attemptCount: 1,
      properties: { inputTokens: 12345, outputTokens: 678, cachedInputTokens: 200 },
    });
    reopened.close();
  });
  it("never hands out a queued agent feedback report, even after a restart", () => {
    const path = fixturePath();
    const first = new AnalyticsOutbox(path);
    const ordinary = event("surface.opened");
    const report = {
      ...event("surface.opened"),
      name: "agent.feedback",
      properties: { expected: "synthetic expected", actual: "synthetic actual" },
    } as AnalyticsEvent;
    expect(first.enqueueBatch([report, ordinary], ["core", "core"])).toBe(2);
    first.close();
    const reopened = new AnalyticsOutbox(path);
    const pending = reopened.pending(50, Date.parse("2026-10-20T00:00:00.000Z"));
    expect(pending.map((queued) => queued.name)).toEqual(["surface.opened"]);
    expect(reopened.pending(50, Date.parse("2026-10-20T00:00:00.000Z"))).toHaveLength(1);
    reopened.close();
  });
  it("writes a coalesced batch transaction and delivers critical events first", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const events = [event("surface.opened"), event("app.health"), event("project.opened")];
    const priorities: AnalyticsPriority[] = ["summary", "critical", "core"];

    expect(outbox.enqueueBatch(events, priorities)).toBe(3);
    expect(
      outbox.pending(3, Date.parse("2026-10-20T00:00:00.000Z")).map((pending) => pending.name),
    ).toEqual(["app.health", "project.opened", "surface.opened"]);
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
    expect(outbox.pending(10, Date.parse("2026-10-20T00:00:00.000Z"))).toEqual([]);
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
    expect(outbox.takeDroppedCount()).toBe(2);
    expect(outbox.pending(1, Date.parse("2026-10-20T00:00:00.000Z"))[0]?.name).toBe("app.health");
    outbox.close();
  });

  it("quarantines forbidden persisted properties and retires expired or repeatedly rejected rows", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const now = Date.parse("2026-10-20T00:00:00.000Z");
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
    const rejected = event("app.health");
    const unreachable = event("app.health");
    outbox.enqueueBatch(
      [safe, injected, old, diagnostic, rejected, unreachable],
      Array.from({ length: 6 }, () => "core"),
    );
    for (let i = 0; i < 20; i += 1) outbox.markRejected([rejected.id], "http-400", 0);
    for (let i = 0; i < 25; i += 1) outbox.markAttempted([unreachable.id], "timeout");
    expect(
      outbox
        .pending(50, now)
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual([safe.id, unreachable.id].toSorted());
    expect(outbox.size()).toBe(2);
    expect(outbox.takeDroppedCount()).toBe(4);
    expect(outbox.takeDroppedCount()).toBe(0);
    outbox.close();
  });

  it("holds a rejected event until its retry time but leaves a transport failure due", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const now = Date.parse("2026-10-20T00:00:00.000Z");
    const rejected = event("app.health");
    const timedOut = event("project.opened");
    outbox.enqueueBatch([rejected, timedOut], ["core", "core"]);
    outbox.markRejected([rejected.id], "http-400", now + 5_000);
    outbox.markAttempted([timedOut.id], "timeout");
    expect(outbox.pending(50, now)).toMatchObject([
      { id: timedOut.id, attemptCount: 1, rejectionCount: 0 },
    ]);
    expect(
      outbox
        .pending(50, now + 5_000)
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual([rejected.id, timedOut.id].toSorted());
    outbox.close();
  });
});
