// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Focused priority and batching tests for the worker-owned outbox.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { AnalyticsEvent, AnalyticsPriority } from "./contract.ts";
import { AnalyticsOutbox } from "./outbox.ts";

const fixtures: string[] = [];

function fixturePath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-outbox-"));
  fixtures.push(root);
  return NodePath.join(root, "outbox.sqlite");
}

function event(name: string): AnalyticsEvent {
  return {
    id: NodeCrypto.randomUUID(),
    name,
    distinct_id: `installation:${NodeCrypto.randomUUID()}`,
    session_id: `session:${NodeCrypto.randomUUID()}`,
    occurred_at: new Date().toISOString(),
    privacy_level: "product",
    consent_level: "product",
    properties: {},
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("AnalyticsOutbox", () => {
  it("writes a coalesced batch transaction and delivers critical events first", () => {
    const outbox = new AnalyticsOutbox(fixturePath());
    const events = [event("summary"), event("critical"), event("core")];
    const priorities: AnalyticsPriority[] = ["summary", "critical", "core"];

    expect(outbox.enqueueBatch(events, priorities)).toBe(3);
    expect(outbox.pending(3, Date.now()).map((pending) => pending.name)).toEqual([
      "critical",
      "core",
      "summary",
    ]);
    outbox.close();
  });
});
