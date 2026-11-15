import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:background-wait-recovery");
const providerThreadId = ProviderThreadId.make("provider-thread:background-wait-recovery");
const providerSessionId = ProviderSessionId.make("provider-session:background-wait-recovery");
const driver = ProviderDriverKind.make("claudeAgent");

it.effect.each(["settled", "running"] as const)(
  "a background wait the adapter cannot match reports %s tasks to the agent",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        createdAt: now,
        updatedAt: now,
      } as unknown as OrchestrationV2ProviderThread;
      const runtime = {
        driver,
        providerSessionId,
        awaitBackgroundTasks: () =>
          Effect.succeed(
            outcome === "settled"
              ? { matched: [], settled: ["bash_9"] }
              : { matched: [], running: [{ taskId: "bash_2", description: "npm test" }] },
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layer = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Effect.succeedSome(runtime),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      const result = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.flatMap((service) =>
          service.awaitBackgroundTasks({
            threadId,
            taskIds: outcome === "settled" ? ["bash_9"] : ["bash_1"],
            awaited: true,
          }),
        ),
        Effect.result,
        Effect.provide(Layer.merge(layer, ThreadCommandExecutor.layer)),
      );

      if (outcome === "settled") {
        expect(result).toMatchObject({
          success: { matched: [], unmatched: [], settled: ["bash_9"] },
        });
      } else {
        expect(result).toMatchObject({ failure: { reason: "unmatched" } });
        expect(result._tag === "Failure" && result.failure.message).toContain(
          "Running and not yet awaited here: `bash_2` (npm test).",
        );
      }
    }),
);
