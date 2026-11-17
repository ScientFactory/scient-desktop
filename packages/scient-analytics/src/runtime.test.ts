// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Focused worker/outbox integration tests.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createAnalyticsRuntime, type AnalyticsRuntimeOptions } from "./runtime.ts";
import type { AnalyticsBatch } from "./contract.ts";
import { eventContractViolation } from "./wireContract.ts";

const fixtures: string[] = [];
const servers: NodeHttp.Server[] = [];

function fixturePath(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-analytics-"));
  fixtures.push(root);
  return NodePath.join(root, "outbox.sqlite");
}

function options(overrides: Partial<AnalyticsRuntimeOptions> = {}): AnalyticsRuntimeOptions {
  return {
    enabled: true,
    outboxPath: fixturePath(),
    appVersion: "0.0.32",
    buildChannel: "development",
    endpoint: "http://127.0.0.1:1/v1/events",
    ...overrides,
  };
}

async function ingestionServer(): Promise<{
  readonly endpoint: string;
  readonly bodies: unknown[];
  readonly installationTokens: string[];
}> {
  const bodies: unknown[] = [];
  const installationTokens: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    installationTokens.push(String(request.headers["x-scient-installation-token"] ?? ""));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly events: ReadonlyArray<unknown>;
      };
      bodies.push(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ accepted: body.events.length }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/events`,
    bodies,
    installationTokens,
  };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of fixtures.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("Scient analytics background runtime", () => {
  it("delivers capture and voice summaries through the real worker/outbox using the existing gateway contract", async () => {
    const server = await ingestionServer();
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));
    try {
      expect(
        runtime.record("scient.operation.completed", {
          operationKind: "compute-artifact",
          captureSchemaVersion: 2,
          captureSource: "interactive",
          captureOutcome: "retained",
          captureCoverage: "partial",
          captureReason: "scan-depth-limit",
          retainedOutputCount: 2,
          rejectedOutputCount: 0,
        }),
      ).toBe(true);
      expect(
        runtime.record("voice.transcription.started", {
          voiceSchemaVersion: 2,
          engineClass: "local-whisper",
        }),
      ).toBe(true);
      expect(
        runtime.record("voice.transcription.completed", {
          voiceSchemaVersion: 2,
          engineClass: "local-whisper",
          correctionOutcome: "fallback",
          durationMs: 1000,
          transcriptionDurationMs: 300,
          correctionDurationMs: 700,
          audioDurationMs: 3000,
        }),
      ).toBe(true);
      expect(
        runtime.record("voice.recording.failed", {
          voiceSchemaVersion: 2,
          stage: "recording",
          failureClass: "permission",
        }),
      ).toBe(true);
      expect(await runtime.pendingCount()).toBe(4);
      expect(await runtime.flush()).toBe(4);
      // Only the delivery diagnostics event that this flush reported is left.
      expect(await runtime.pendingCount()).toBe(1);
      const events = (server.bodies as AnalyticsBatch[]).flatMap((body) => body.events);
      expect(events).toHaveLength(4);
      for (const event of events)
        expect(
          eventContractViolation({
            name: event.name,
            properties: event.properties,
            privacyLevel: event.privacy_level,
            consentLevel: event.consent_level,
          }),
        ).toBeNull();
      expect(
        events.find((event) => event.name === "scient.operation.completed")?.properties,
      ).toMatchObject({
        captureOutcome: "retained",
        captureCoverage: "partial",
        retainedOutputCountBucket: "2-3",
      });
      expect(
        events.find((event) => event.name === "voice.transcription.completed")?.properties,
      ).toMatchObject({
        correctionOutcome: "fallback",
        transcriptionDurationBucket: expect.any(String),
        correctionDurationBucket: expect.any(String),
      });
      expect(JSON.stringify(events)).not.toMatch(
        /"(?:collectionContext|audioBase64|transcript|text)"|DurationMs|retainedOutputCount"/u,
      );
    } finally {
      await runtime.close();
    }
  });
  it("emits bounded delivery diagnostics without creating a feedback loop", async () => {
    const server = await ingestionServer();
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));
    try {
      runtime.record("server.boot.heartbeat");
      expect(await runtime.flush()).toBe(1);
      expect(await runtime.pendingCount()).toBe(1);
      expect(await runtime.flush()).toBe(1);
      expect(await runtime.pendingCount()).toBe(0);
      expect(server.bodies[1]).toMatchObject({
        events: [
          {
            name: "app.diagnostics",
            privacy_level: "diagnostic",
            properties: {
              deliveryClass: "delivered",
              queuedCountBucket: "0",
              retryCountBucket: "0",
              droppedCountBucket: "0",
              oldestEventAgeBucket: "under-1m",
            },
          },
        ],
      });
    } finally {
      await runtime.close();
    }
  });

  it("creates no worker state when analytics is disabled", async () => {
    const outboxPath = fixturePath();
    const runtime = createAnalyticsRuntime(options({ enabled: false, outboxPath }));

    expect(runtime.record("server.boot.heartbeat")).toBe(false);
    expect(await runtime.flush()).toBe(0);
    await runtime.close();

    expect(NodeFS.existsSync(outboxPath)).toBe(false);
  });

  it("persists and delivers the normalized event with new fields but no paths", async () => {
    const server = await ingestionServer();
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));

    expect(
      runtime.record("provider.turn.sent", {
        provider: "codex",
        model: "gpt-6.1-luna",
        interactionMode: "plan",
        runtimeMode: "full-access",
        attachmentCount: 4,
        hasInput: true,
        serviceTier: "fast",
        projectPath: "/private/project",
        prompt: "PRIVATE-CONTENT",
      }),
    ).toBe(true);
    expect(await runtime.flush()).toBe(1);
    await runtime.close();

    const payload = server.bodies[0];
    expect(server.installationTokens).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(JSON.stringify(payload)).not.toContain("/private/project");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE-CONTENT");
    expect(payload).toMatchObject({
      schema_version: 1,
      source: "desktop",
      events: [
        {
          name: "provider.turn.sent",
          privacy_level: "product",
          consent_level: "diagnostic",
          properties: {
            appVersion: "0.0.32",
            buildChannel: "development",
            provider: "codex",
            modelFamily: "openai",
            modelKey: "gpt-6.1-luna",
            interactionMode: "plan",
            runtimeMode: "full-access",
            attachmentCountBucket: "4-10",
            hasInput: true,
            serviceTier: "fast",
            contractRevision: "11",
          },
        },
      ],
    });
  });

  it("retains locally persisted events across restart without a shutdown network wait", async () => {
    const outboxPath = fixturePath();
    const first = createAnalyticsRuntime(options({ outboxPath }));
    first.record("server.boot.heartbeat");
    expect(await first.pendingCount()).toBe(1);
    await first.close();

    const server = await ingestionServer();
    const restarted = createAnalyticsRuntime(options({ outboxPath, endpoint: server.endpoint }));
    expect(await restarted.pendingCount()).toBe(1);
    expect(await restarted.flush()).toBe(1);
    // Only the delivery diagnostics event that this flush reported is left.
    expect(await restarted.pendingCount()).toBe(1);
    await restarted.close();
  });

  it("quarantines corrupt rows after restart", async () => {
    const outboxPath = fixturePath();
    const first = createAnalyticsRuntime(options({ outboxPath }));
    first.record("server.boot.heartbeat");
    expect(await first.pendingCount()).toBe(1);
    await first.close();

    const database = new NodeSqlite.DatabaseSync(outboxPath);
    database.exec("UPDATE analytics_outbox SET properties_json = 'not-json', next_attempt_at = 0");
    database.close();

    const server = await ingestionServer();
    const restarted = createAnalyticsRuntime(options({ outboxPath, endpoint: server.endpoint }));
    expect(await restarted.flush()).toBe(0);
    expect(await restarted.pendingCount()).toBe(0);
    await restarted.close();

    const inspected = new NodeSqlite.DatabaseSync(outboxPath);
    const deadLetters = inspected
      .prepare("SELECT COUNT(*) AS count FROM analytics_dead_letter")
      .get() as { readonly count: number };
    inspected.close();
    expect(deadLetters.count).toBe(1);
    expect(server.bodies).toHaveLength(0);
  });
});
