// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Focused worker/outbox integration tests.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { createAnalyticsRuntime, type AnalyticsRuntimeOptions } from "./runtime.ts";

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
    consent: "product",
    outboxPath: fixturePath(),
    appVersion: "0.0.32",
    buildChannel: "development",
    ...overrides,
  };
}

async function ingestionServer(deleteAccepted = true): Promise<{
  readonly endpoint: string;
  readonly bodies: unknown[];
  readonly installationTokens: string[];
  readonly deletionBodies: unknown[];
}> {
  const bodies: unknown[] = [];
  const installationTokens: string[] = [];
  const deletionBodies: unknown[] = [];
  const server = NodeHttp.createServer((request, response) => {
    installationTokens.push(String(request.headers["x-scient-installation-token"] ?? ""));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly events: ReadonlyArray<unknown>;
      };
      if (request.url === "/v1/installations/delete") {
        deletionBodies.push(body);
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ accepted: deleteAccepted }));
        return;
      }
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
    deletionBodies,
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
  it("creates no worker state when analytics is disabled", async () => {
    const outboxPath = fixturePath();
    const runtime = createAnalyticsRuntime(options({ enabled: false, outboxPath }));

    expect(runtime.record("server.boot.heartbeat")).toBe(false);
    expect(await runtime.flush()).toBe(0);
    await runtime.close();

    expect(NodeFS.existsSync(outboxPath)).toBe(false);
  });

  it("persists and delivers only the bounded normalized contract", async () => {
    const server = await ingestionServer();
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));

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

    const payload = server.bodies[0];
    expect(server.installationTokens).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
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
            appVersion: "0.0.32",
            buildChannel: "development",
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
    expect(await restarted.pendingCount()).toBe(0);
    await restarted.close();
  });

  it("purges disallowed data on consent reduction and quarantines corrupt rows", async () => {
    const outboxPath = fixturePath();
    const first = createAnalyticsRuntime(options({ outboxPath }));
    first.record("server.boot.heartbeat");
    first.record("provider.turn.sent", { provider: "codex" });
    expect(await first.pendingCount()).toBe(2);
    expect(await first.setConsent("essential")).toBe(1);
    await first.close();

    const database = new NodeSqlite.DatabaseSync(outboxPath);
    database.exec("UPDATE analytics_outbox SET properties_json = 'not-json', next_attempt_at = 0");
    database.close();

    const server = await ingestionServer();
    const restarted = createAnalyticsRuntime(
      options({ outboxPath, endpoint: server.endpoint, consent: "essential" }),
    );
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

  it("deletes the authenticated installation and rotates its local identity", async () => {
    const server = await ingestionServer();
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));
    runtime.record("server.boot.heartbeat");
    expect(await runtime.flush()).toBe(1);

    const firstBatch = server.bodies[0] as {
      readonly events: ReadonlyArray<{ readonly distinct_id: string }>;
    };
    expect(await runtime.deleteData()).toBe(true);
    expect(server.deletionBodies).toEqual([
      { schema_version: 1, installation_id: firstBatch.events[0]?.distinct_id },
    ]);

    runtime.record("server.boot.heartbeat");
    expect(await runtime.flush()).toBe(1);
    await runtime.close();

    const secondBatch = server.bodies[1] as {
      readonly events: ReadonlyArray<{ readonly distinct_id: string }>;
    };
    expect(secondBatch.events[0]?.distinct_id).not.toBe(firstBatch.events[0]?.distinct_id);
    expect(server.installationTokens[2]).not.toBe(server.installationTokens[0]);
  });

  it("retains local events when the deletion gateway does not acknowledge erasure", async () => {
    const server = await ingestionServer(false);
    const runtime = createAnalyticsRuntime(options({ endpoint: server.endpoint }));
    runtime.record("server.boot.heartbeat");

    expect(await runtime.deleteData()).toBe(false);
    expect(await runtime.pendingCount()).toBe(1);
    expect(await runtime.flush()).toBe(1);
    await runtime.close();

    expect(server.deletionBodies).toHaveLength(1);
    expect(server.bodies).toHaveLength(1);
  });
});
