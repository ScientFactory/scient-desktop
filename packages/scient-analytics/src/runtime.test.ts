// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- These tests exercise the real local SQLite outbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createAnalyticsRuntime } from "./runtime.ts";

const fixtures: string[] = [];

function fixturePath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-analytics-"));
  fixtures.push(root);
  return NodePath.join(root, "outbox.sqlite");
}

function options(overrides: Partial<Parameters<typeof createAnalyticsRuntime>[0]> = {}) {
  return {
    enabled: true,
    consent: "product" as const,
    outboxPath: fixturePath(),
    appVersion: "0.0.32",
    buildChannel: "development" as const,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("Scient analytics runtime", () => {
  it("does not create state or use the network when disabled", async () => {
    const outboxPath = fixturePath();
    let requests = 0;
    const runtime = createAnalyticsRuntime({
      ...options({ outboxPath }),
      enabled: false,
      fetch: async () => {
        requests += 1;
        return Response.json({ accepted: 0 });
      },
    });

    expect(runtime.record("server.boot.heartbeat")).toBe(false);
    expect(await runtime.flush()).toBe(0);
    await runtime.close();

    expect(requests).toBe(0);
    expect(NodeFS.existsSync(outboxPath)).toBe(false);
  });

  it("sends only the bounded normalized contract and never the raw model", async () => {
    let payload: unknown;
    const runtime = createAnalyticsRuntime(
      options({
        randomUUID: (() => {
          let index = 0;
          return () => `00000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
        })(),
        fetch: async (_url, init) => {
          payload = JSON.parse(String(init?.body));
          return Response.json({ accepted: 1 });
        },
      }),
    );

    expect(
      runtime.record("provider.turn.sent", {
        provider: "codex",
        model: "gpt-5.6-private-model-name",
        interactionMode: "plan",
        runtimeMode: "full-access",
        attachmentCount: 4,
        hasInput: true,
        projectPath: "/private/project",
      }),
    ).toBe(true);
    expect(await runtime.flush()).toBe(1);
    await runtime.close();

    expect(JSON.stringify(payload)).not.toContain("gpt-5.6-private-model-name");
    expect(JSON.stringify(payload)).not.toContain("/private/project");
    expect(payload).toMatchObject({
      schema_version: 1,
      source: "desktop",
      events: [
        {
          name: "provider.turn.sent",
          privacy_level: "product",
          consent_level: "product",
          properties: {
            provider: "codex",
            modelFamily: "openai",
            interactionMode: "plan",
            runtimeMode: "full-access",
            attachmentCountBucket: "4-10",
            hasInput: true,
          },
        },
      ],
    });
  });

  it("suppresses unknown events and events above the current consent", async () => {
    const runtime = createAnalyticsRuntime(options({ consent: "essential" }));

    expect(runtime.record("provider.turn.sent", { provider: "codex" })).toBe(false);
    expect(runtime.record("unregistered.event", { arbitrary: "value" })).toBe(false);
    expect(runtime.record("server.boot.heartbeat", { threadCount: 999 })).toBe(true);
    expect(runtime.pendingCount()).toBe(1);
    runtime.setConsent("off");
    await runtime.close();
  });

  it("classifies known model families locally without retaining model text", async () => {
    let payload = "";
    const runtime = createAnalyticsRuntime(
      options({
        fetch: async (_url, init) => {
          payload = String(init?.body);
          return Response.json({ accepted: 1 });
        },
      }),
    );

    runtime.record("provider.turn.sent", { provider: "opencode", model: "google/gemini-3-pro" });
    await runtime.flush();
    await runtime.close();

    expect(payload).toContain('"modelFamily":"google"');
    expect(payload).not.toContain("gemini-3-pro");
  });

  it("makes event insertion idempotent by event id", async () => {
    const ids = ["install", "session", "same-event", "same-event"];
    const runtime = createAnalyticsRuntime(
      options({ randomUUID: () => ids.shift() ?? "unexpected" }),
    );

    expect(runtime.record("server.boot.heartbeat")).toBe(true);
    expect(runtime.record("server.boot.heartbeat")).toBe(false);
    expect(runtime.pendingCount()).toBe(1);
    runtime.setConsent("off");
    await runtime.close();
  });

  it("retains queued events across restart and removes them only after an exact acknowledgement", async () => {
    const outboxPath = fixturePath();
    const first = createAnalyticsRuntime(
      options({
        outboxPath,
        fetch: async () => {
          throw new Error("offline with potentially sensitive details");
        },
      }),
    );
    first.record("server.boot.heartbeat");
    await first.close();

    const restarted = createAnalyticsRuntime(
      options({
        outboxPath,
        now: () => new Date("2100-01-01T00:00:00.000Z"),
        fetch: async () => Response.json({ accepted: 1 }),
      }),
    );
    expect(restarted.pendingCount()).toBe(1);
    expect(await restarted.flush()).toBe(1);
    expect(restarted.pendingCount()).toBe(0);
    await restarted.close();
  });

  it("keeps events queued after a rejected or malformed delivery", async () => {
    let requests = 0;
    const runtime = createAnalyticsRuntime(
      options({
        fetch: async () => {
          requests += 1;
          return Response.json({ accepted: 0 });
        },
      }),
    );
    runtime.record("server.boot.heartbeat");

    expect(await runtime.flush()).toBe(0);
    expect(runtime.pendingCount()).toBe(1);
    expect(await runtime.flush()).toBe(0);
    expect(requests).toBe(1);
    runtime.setConsent("off");
    await runtime.close();
  });

  it("purges locally queued events when consent is reduced", async () => {
    const runtime = createAnalyticsRuntime(options());
    runtime.record("server.boot.heartbeat");
    runtime.record("provider.turn.sent", { provider: "codex" });

    expect(runtime.pendingCount()).toBe(2);
    expect(runtime.setConsent("essential")).toBe(1);
    expect(runtime.pendingCount()).toBe(1);
    expect(runtime.setConsent("off")).toBe(1);
    expect(runtime.pendingCount()).toBe(0);
    await runtime.close();
  });

  it("quarantines corrupt local rows without sending or blocking later delivery", async () => {
    const outboxPath = fixturePath();
    const first = createAnalyticsRuntime(
      options({
        outboxPath,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );
    first.record("server.boot.heartbeat");
    await first.close();

    const database = new NodeSqlite.DatabaseSync(outboxPath);
    database.exec("UPDATE analytics_outbox SET properties_json = 'not-json', next_attempt_at = 0");
    database.close();

    let requests = 0;
    const restarted = createAnalyticsRuntime(
      options({
        outboxPath,
        fetch: async () => {
          requests += 1;
          return Response.json({ accepted: 1 });
        },
      }),
    );
    expect(await restarted.flush()).toBe(0);
    expect(restarted.pendingCount()).toBe(0);
    expect(requests).toBe(0);
    expect(restarted.record("server.boot.heartbeat")).toBe(true);
    expect(await restarted.flush()).toBe(1);
    expect(requests).toBe(1);
    await restarted.close();

    const inspected = new NodeSqlite.DatabaseSync(outboxPath);
    const deadLetters = inspected
      .prepare("SELECT COUNT(*) AS count FROM analytics_dead_letter")
      .get() as { readonly count: number };
    inspected.close();
    expect(deadLetters.count).toBe(1);
  });
});
