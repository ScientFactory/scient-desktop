import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import type { ProviderNativeInventory } from "../../provider/ScientProviderInstanceSeams.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
import {
  awaitUntil,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  WAKE_NATIVE_SESSION,
} from "./ClaudeAdapterV2.wake.testkit.ts";

describe("ClaudeAdapterV2 provider-native inventory", () => {
  it.effect("updates MCP status at turn end and never reports servers Scient set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports: Array<ProviderNativeInventory> = [];
        const turnEndStatus: ReadonlyArray<McpServerStatus> = [
          { name: "github", status: "connected", scope: "user", tools: [{ name: "issues" }] },
          { name: "sentry", status: "failed", scope: "project", error: "spawn ENOENT" },
          // Scient's own endpoint and a delivered connector, as Claude reports them.
          { name: "scient", status: "connected", source: "dynamic" },
          { name: "linear", status: "connected", source: "dynamic" },
        ];
        const harness = yield* makeWakeHarnessWithOptions({
          onNativeInventory: (inventory) => Effect.sync(() => void reports.push(inventory)),
          mcpServerStatus: Effect.succeed(turnEndStatus),
        });
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-claude-native-inventory"),
          threadId: harness.threadId,
          providerSessionId: "mcp-session-claude-native-inventory",
          providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer native-inventory-token",
          capabilities: new Set(),
          connectors: [
            {
              connectorId: "connector-linear",
              serverName: "linear",
              displayName: "Linear",
              url: "http://127.0.0.1:43123/mcp/connectors/connector-linear",
            },
          ],
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-native-inventory"),
            text: "List my issues.",
            attachments: [],
          }),
        );
        assert.includeMembers(Object.keys(harness.getOpenedOptions()?.mcpServers ?? {}), [
          "scient",
          "linear",
        ]);

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "init",
            uuid: "00000000-0000-4000-8000-000000009001",
            session_id: WAKE_NATIVE_SESSION,
            plugins: [{ name: "review-tools", path: "/plugins/review-tools" }],
            mcp_servers: [
              { name: "github", status: "pending", source: "user" },
              { name: "sentry", status: "pending", source: "project" },
              { name: "scient", status: "connected", source: "dynamic" },
              { name: "linear", status: "pending", source: "dynamic" },
            ],
          }),
        );
        assert.deepStrictEqual(reports[0]?.mcpServers, [
          { name: "github", status: "pending", scope: "user" },
          { name: "sentry", status: "pending", scope: "project" },
        ]);

        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000009002", result: "Done." }),
        );
        yield* awaitUntil(() => reports.length === 2, "the turn-end MCP status sample");
        assert.deepStrictEqual(reports[1], {
          mcpServers: [
            { name: "github", status: "connected", scope: "user", toolCount: 1 },
            { name: "sentry", status: "failed", scope: "project", error: "spawn ENOENT" },
          ],
        });
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("keeps the last report when the turn-end sample fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports: Array<ProviderNativeInventory> = [];
        const harness = yield* makeWakeHarnessWithOptions({
          onNativeInventory: (inventory) => Effect.sync(() => void reports.push(inventory)),
          mcpServerStatus: Effect.fail(
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "mcpServerStatus",
              cause: new Error("control request timed out"),
            }),
          ),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-native-inventory-failure"),
            text: "Hello.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000009003", result: "Hi." }),
        );
        for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow;
        assert.deepStrictEqual(reports, []);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
