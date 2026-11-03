import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { t3OrchestrationPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

describe("CursorAdapterV2 host first-run copy", () => {
  it.effect("re-sends host copy when the session's grants change, and after compaction", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-grants-" });
      const sentMessages: Array<string> = [];
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-grants-thread");
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const grant = (capabilities: ReadonlyArray<string>) =>
        mcpSessions.set({
          environmentId: EnvironmentId.make("cursor-grants-environment"),
          threadId,
          providerSessionId: "cursor-grants-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer synthetic-cursor-token",
          capabilities: new Set(capabilities),
          connectors: [],
        });
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
        // A host composer whose text names the grants, as Scient's awareness does.
        orchestrationPromptForFirstRun: (input) =>
          t3OrchestrationPrompt({
            ...input,
            instructions: `grants:${[...(input.capabilities ?? [])].toSorted().join(",")}`,
          }),
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-grants",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  const runId = `native-cursor-run-${sentMessages.length}`;
                  return {
                    agentId: "native-cursor-grants",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-request-${sentMessages.length}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-grants-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-grants-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor grants",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      let runOrdinal = 0;
      /** The grants named in what was sent, or null when no host copy went with it. */
      const send = Effect.fnUntraced(function* (compact = false) {
        runOrdinal += 1;
        const turnInput = {
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make(`cursor-grants-run-${runOrdinal}`),
          runOrdinal,
          providerTurnOrdinal: runOrdinal,
          attemptId: RunAttemptId.make(`cursor-grants-attempt-${runOrdinal}`),
          rootNodeId: NodeId.make(`cursor-grants-root-${runOrdinal}`),
          appThread,
          message: {
            messageId: MessageId.make(`cursor-grants-message-${runOrdinal}`),
            createdBy: "user" as const,
            creationSource: "web" as const,
            text: "Continue.",
            attachments: [],
          },
        };
        yield* compact ? runtime.compactThread!(turnInput) : runtime.startTurn(turnInput);
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        return /grants:([a-z:,-]*)/.exec(sentMessages.at(-1)!)?.[1] ?? null;
      });

      yield* grant(["accounts"]);
      assert.equal(yield* send(), "accounts");
      assert.equal(yield* send(), null);
      yield* grant(["accounts", "compute", "preview"]);
      assert.equal(yield* send(), "accounts,compute,preview", "widened grants");
      assert.equal(yield* send(), null);
      yield* send(true);
      assert.equal(yield* send(), "accounts,compute,preview", "compaction drops the host copy");
      assert.equal(yield* send(), null);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
