import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScientQueueWorker, ScientQueueWorkerLive } from "./Worker.ts";
import { readQueue, writeQueue, finalizeQueueTurn } from "./Ledger.ts";
import { enqueueQueue } from "./operations.ts";

const engineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
);
const testLayer = ScientQueueWorkerLive.pipe(
  Layer.provideMerge(engineLayer),
  Layer.provide(WorkspacePaths.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-queue-worker-" })),
  Layer.provide(NodeServices.layer),
);
const now = "2026-09-04T00:00:00.000Z";
const threadId = ThreadId.make("background-queue");
const projectId = ProjectId.make("queue-project");

it.effect.each(["normal", "manual-recovery", "automation-recovery", "restart-recovery"] as const)(
  "delivers without an open client after both finalizers: %s",
  (scenario) =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* ScientQueueWorker;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project"),
        projectId,
        title: "Queue test",
        workspaceRoot: "/tmp",
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Queue",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      const starts = yield* Queue.unbounded<string>();
      const events = yield* engine.subscribeDomainEvents;
      yield* events.pipe(
        Stream.runForEach((event) =>
          event.type === "thread.turn-start-requested"
            ? Queue.offer(starts, event.payload.messageId).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      if (scenario !== "restart-recovery") {
        yield* worker.start;
        yield* worker.start; // Repeated lifecycle start must not launch another sender.
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          let doc = yield* readQueue(threadId);
          for (const id of ["A", "B"])
            doc = yield* enqueueQueue(
              {
                threadId,
                queueItemId: `qitem_${id}`,
                text: id,
                attachments: [],
                runtimeMode: "approval-required",
                interactionMode: "plan",
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
              },
              doc,
            );
          yield* writeQueue(
            threadId,
            scenario === "restart-recovery"
              ? { ...doc, blocked: true, turnId: "before-restart" }
              : doc,
          );
        }),
      );
      if (scenario === "restart-recovery") {
        yield* worker.start;
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(true);
        yield* finalizeQueueTurn(threadId, "before-restart", true, "answer");
        yield* finalizeQueueTurn(threadId, "before-restart", true, "checkpoint");
        expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["A", "B"]);
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("resume-restart"),
          threadId,
          message: {
            messageId: MessageId.make("resume-restart"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          sendIntent: "normal",
          createdAt: now,
        });
        expect(yield* Queue.take(starts)).toBe("resume-restart");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("restart-running"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("restart-answer"),
            lastError: null,
            updatedAt: now,
          },
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("restart-ready"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        });
        yield* finalizeQueueTurn(threadId, "restart-answer", true, "answer");
        expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["A", "B"]);
        yield* finalizeQueueTurn(threadId, "restart-answer", true, "checkpoint");
      }
      expect(yield* Queue.take(starts)).toBe("queue:qitem_A");
      expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
      const detail = yield* query.getThreadDetailById(threadId);
      expect(Option.isSome(detail) && detail.value.modelSelection.model).toBe("gpt-5.5");
      expect(Option.isSome(detail) && detail.value.runtimeMode).toBe("approval-required");
      expect(Option.isSome(detail) && detail.value.interactionMode).toBe("plan");
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("running"),
        threadId,
        createdAt: now,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-A"),
          lastError: null,
          updatedAt: now,
        },
      });
      if (scenario === "manual-recovery" || scenario === "automation-recovery") {
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          createdAt: now,
        });
      }
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("ready"),
        threadId,
        createdAt: now,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      });
      if (scenario === "manual-recovery" || scenario === "automation-recovery") {
        yield* finalizeQueueTurn(threadId, "turn-A", true, "answer");
        yield* finalizeQueueTurn(threadId, "turn-A", true, "checkpoint");
        expect((yield* readQueue(threadId)).awaitingCompletion).toBe(true);
        expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("resume"),
          threadId,
          message: {
            messageId: MessageId.make("resume"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
          ...(scenario === "manual-recovery" ? { sendIntent: "normal" as const } : {}),
        });
        expect(yield* Queue.take(starts)).toBe("resume");
        expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("resume-running"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("resumed-answer"),
            lastError: null,
            updatedAt: now,
          },
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("resume-ready"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        });
      }
      const finalTurn =
        scenario === "manual-recovery" || scenario === "automation-recovery"
          ? "resumed-answer"
          : "turn-A";
      yield* finalizeQueueTurn(threadId, finalTurn, true, "answer");
      expect((yield* readQueue(threadId)).blocked).toBe(true);
      yield* finalizeQueueTurn(threadId, finalTurn, true, "checkpoint");
      expect(yield* Queue.take(starts)).toBe("queue:qitem_B");
      // Receipt order above proves delivery order; projection order uses client timestamps.
      const final = yield* query.getThreadDetailById(threadId);
      expect(
        Option.isSome(final) &&
          final.value.messages
            .filter((message) => message.role === "user")
            .map((message) => message.id)
            .toSorted(),
      ).toEqual(
        (scenario === "restart-recovery"
          ? ["resume-restart", "queue:qitem_A", "queue:qitem_B"]
          : scenario === "normal"
            ? ["queue:qitem_A", "queue:qitem_B"]
            : ["queue:qitem_A", "resume", "queue:qitem_B"]
        ).toSorted(),
      );
      expect((yield* readQueue(threadId)).items).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);
