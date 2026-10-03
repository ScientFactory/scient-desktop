import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  MessageId,
  ComposerContextId,
  type OrchestrationMessageContext,
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
import * as ThreadBackgroundLiveness from "../../orchestration-v2/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration-v2/ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScientQueueWorker, ScientQueueWorkerLive } from "./Worker.ts";
import { readQueue, writeQueue, finalizeQueueTurn, type QueueDocument } from "./Ledger.ts";
import { controlQueue, enqueueQueue } from "./operations.ts";

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
const makeTestLayer = (onRead?: (id: ThreadId, status: string | undefined) => void) => {
  const workerLayer = onRead
    ? ScientQueueWorkerLive.pipe(
        Layer.provide(
          Layer.effect(
            ProjectionSnapshotQuery,
            Effect.gen(function* () {
              const query = yield* ProjectionSnapshotQuery;
              return {
                ...query,
                getThreadDetailById: (id, options) =>
                  query
                    .getThreadDetailById(id, options)
                    .pipe(
                      Effect.tap((target) =>
                        Effect.sync(() =>
                          onRead(
                            id,
                            Option.isSome(target) ? target.value.session?.status : undefined,
                          ),
                        ),
                      ),
                    ),
              } satisfies typeof query;
            }),
          ),
        ),
      )
    : ScientQueueWorkerLive;
  return workerLayer.pipe(
    Layer.provideMerge(engineLayer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-queue-worker-" })),
    Layer.provide(NodeServices.layer),
  );
};
const testLayer = makeTestLayer();
const now = "2026-09-04T00:00:00.000Z";
const threadId = ThreadId.make("background-queue");
const projectId = ProjectId.make("queue-project");
const messageContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      kind: "terminal",
      contextId: ComposerContextId.make("ctx_terminal"),
      label: "Terminal",
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "measured value 42",
    },
  ],
};

it.effect(
  "delivers an explicitly sent waiting message without a client, then resumes after checkpoint failure",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* ScientQueueWorker;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("send-project"),
        projectId,
        title: "Queue test",
        workspaceRoot: "/tmp",
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("send-thread"),
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
      yield* sql.withTransaction(
        Effect.gen(function* () {
          let doc = yield* readQueue(threadId);
          for (const id of ["A", "B"])
            doc = yield* enqueueQueue(
              { threadId, queueItemId: `qitem_${id}`, text: id, attachments: [] },
              doc,
            );
          yield* writeQueue(threadId, { ...doc, awaitingCompletion: true });
        }),
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const doc = yield* readQueue(threadId);
          yield* writeQueue(
            threadId,
            yield* controlQueue({ threadId, action: "send", queueItemId: "qitem_A" }, doc),
          );
        }),
      );
      // The explicit request is durable even when no worker or browser is open yet.
      yield* worker.start;
      expect(yield* Queue.take(starts).pipe(Effect.timeout("5 seconds"))).toBe("queue:qitem_A");
      expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("send-running"),
        threadId,
        createdAt: now,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("sent-turn"),
          lastError: null,
          updatedAt: now,
        },
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("send-ready"),
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
      yield* finalizeQueueTurn(threadId, "sent-turn", true, "answer");
      expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
      yield* finalizeQueueTurn(threadId, "sent-turn", false, "checkpoint");
      expect(yield* Queue.take(starts).pipe(Effect.timeout("5 seconds"))).toBe("queue:qitem_B");
      expect((yield* readQueue(threadId)).items).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "normal",
  "manual-recovery",
  "automation-recovery",
  "restart-recovery",
  "token-limit",
] as const)("delivers without an open client after both finalizers: %s", (scenario) =>
  Effect.gen(function* () {
    const needsFollowUp = scenario === "manual-recovery" || scenario === "automation-recovery";
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
    const selectedByMessage = new Map<string, ReadonlyArray<string> | undefined>();
    const events = yield* engine.subscribeDomainEvents;
    yield* events.pipe(
      Stream.runForEach((event) =>
        event.type === "thread.turn-start-requested"
          ? Effect.sync(() =>
              selectedByMessage.set(
                event.payload.messageId,
                event.payload.selectedScientSkillNames,
              ),
            ).pipe(Effect.andThen(Queue.offer(starts, event.payload.messageId)), Effect.asVoid)
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
              selectedScientSkillNames: id === "A" ? ["pdf-authoring"] : [],
              context: messageContext,
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
    expect(selectedByMessage.get("queue:qitem_A")).toEqual(["pdf-authoring"]);
    expect((yield* readQueue(threadId)).items.map((item) => item.text)).toEqual(["B"]);
    const detail = yield* query.getThreadDetailById(threadId);
    expect(
      Option.isSome(detail) &&
        detail.value.messages.find((message) => message.id === "queue:qitem_A")?.context,
    ).toEqual(messageContext);
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
    if (needsFollowUp) {
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
    const finalTurn = needsFollowUp ? "resumed-answer" : "turn-A";
    yield* finalizeQueueTurn(threadId, finalTurn, true, "answer");
    expect((yield* readQueue(threadId)).blocked).toBe(true);
    yield* finalizeQueueTurn(threadId, finalTurn, true, "checkpoint");
    expect(yield* Queue.take(starts)).toBe("queue:qitem_B");
    expect(selectedByMessage.get("queue:qitem_B")).toEqual([]);
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
        : scenario === "normal" || scenario === "token-limit"
          ? ["queue:qitem_A", "queue:qitem_B"]
          : ["queue:qitem_A", "resume", "queue:qitem_B"]
      ).toSorted(),
    );
    expect((yield* readQueue(threadId)).items).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "retries an eligible queue after committed readiness and preserves FIFO under repeated wakeups",
  () =>
    Effect.gen(function* () {
      const reads = yield* Queue.unbounded<string | undefined>();
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const worker = yield* ScientQueueWorker;
        const sql = yield* SqlClient.SqlClient;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("wakeup-project"),
          projectId,
          title: "Queue wakeup",
          workspaceRoot: "/tmp",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("wakeup-thread"),
          threadId,
          projectId,
          title: "Queue wakeup",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const starts = yield* Queue.unbounded<string>();
        const delivered: string[] = [];
        const events = yield* engine.subscribeDomainEvents;
        yield* events.pipe(
          Stream.runForEach((event) =>
            event.type === "thread.turn-start-requested"
              ? Effect.sync(() => delivered.push(event.payload.messageId)).pipe(
                  Effect.andThen(Queue.offer(starts, event.payload.messageId)),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* worker.start;
        const setSession = Effect.fnUntraced(function* (
          commandId: string,
          status: "running" | "ready",
          turn: string | null,
          target = threadId,
        ) {
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(commandId),
            threadId: target,
            createdAt: now,
            session: {
              threadId: target,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: turn === null ? null : TurnId.make(turn),
              lastError: null,
              updatedAt: now,
            },
          });
        });
        const expected: string[] = [];
        // Actual worker reads and committed start events synchronize the test, without sleeps.
        for (let round = 0; round < 24; round++) {
          const previousTurn = `previous-${round}`;
          const first = `qitem_${round}-A`;
          const second = `qitem_${round}-B`;
          yield* setSession(`running-${round}`, "running", previousTurn);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              let doc = yield* readQueue(threadId);
              for (const id of [first, second]) {
                doc = yield* enqueueQueue(
                  { threadId, queueItemId: id, text: id, attachments: [] },
                  doc,
                );
              }
              yield* writeQueue(threadId, { ...doc, blocked: true, turnId: previousTurn });
            }),
          );
          yield* finalizeQueueTurn(threadId, previousTurn, true, "answer");
          yield* finalizeQueueTurn(threadId, previousTurn, round % 2 === 0, "checkpoint");
          expect(yield* Queue.take(reads).pipe(Effect.timeout("5 seconds"))).toBe("running");
          expect((yield* readQueue(threadId)).blocked).toBe(false);
          yield* setSession(`ready-${round}`, "ready", null);
          expect(yield* Queue.take(starts).pipe(Effect.timeout("5 seconds"))).toBe(
            `queue:${first}`,
          );
          expect(yield* Queue.take(reads)).toBe("ready");
          expected.push(`queue:${first}`);
          yield* Effect.forEach(
            Array.from({ length: 12 }, (_, index) => index),
            (index) => setSession(`repeat-${round}-${index}`, "ready", null),
            { concurrency: "unbounded" },
          );
          const afterFirst = yield* readQueue(threadId);
          expect(afterFirst.blocked).toBe(true);
          expect(afterFirst.items.map((item) => item.queueItemId)).toEqual([second]);
          expect(yield* Queue.poll(starts)).toEqual(Option.none());
          // The other ordering remains valid: ready arrives before either finalizer.
          const firstTurn = `first-${round}`;
          yield* setSession(`first-running-${round}`, "running", firstTurn);
          yield* setSession(`first-ready-${round}`, "ready", null);
          yield* finalizeQueueTurn(threadId, firstTurn, true, "checkpoint");
          expect((yield* readQueue(threadId)).blocked).toBe(true);
          yield* finalizeQueueTurn(threadId, firstTurn, true, "answer");
          expect(yield* Queue.take(starts).pipe(Effect.timeout("5 seconds"))).toBe(
            `queue:${second}`,
          );
          expect(yield* Queue.take(reads)).toBe("ready");
          expected.push(`queue:${second}`);
          const secondTurn = `second-${round}`;
          yield* setSession(`second-running-${round}`, "running", secondTurn);
          yield* setSession(`second-ready-${round}`, "ready", null);
          yield* finalizeQueueTurn(threadId, secondTurn, true, "answer");
          yield* finalizeQueueTurn(threadId, secondTurn, true, "checkpoint");
          expect((yield* readQueue(threadId)).items).toEqual([]);
        }
        expect(delivered).toEqual(expected);
        expect(delivered).toHaveLength(48);

        const createThread = Effect.fnUntraced(function* (id: ThreadId) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${id}`),
            threadId: id,
            projectId,
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });
        });
        const protectedQueues = new Map<ThreadId, QueueDocument>();
        for (const guard of ["checkpoint", "failed-answer", "stop", "pause"] as const) {
          const id = ThreadId.make(`guard-${guard}`);
          const turn = `turn-${guard}`;
          yield* createThread(id);
          yield* setSession(`running-${guard}`, "running", turn, id);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const doc = yield* enqueueQueue(
                { threadId: id, queueItemId: `qitem_${guard}`, text: guard, attachments: [] },
                yield* readQueue(id),
              );
              yield* writeQueue(id, { ...doc, blocked: true, turnId: turn });
            }),
          );
          if (guard === "checkpoint") {
            yield* finalizeQueueTurn(id, turn, true, "answer");
          } else if (guard === "pause") {
            const doc = yield* readQueue(id);
            yield* writeQueue(id, {
              ...doc,
              blocked: false,
              turnId: null,
              paused: "Queue paused: fixture failure",
            });
          } else {
            if (guard === "stop") {
              yield* engine.dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make("guard-stop"),
                threadId: id,
                createdAt: now,
              });
            }
            yield* finalizeQueueTurn(id, turn, guard === "stop", "answer");
            yield* finalizeQueueTurn(id, turn, true, "checkpoint");
          }
          yield* setSession(`ready-${guard}`, "ready", null, id);
          protectedQueues.set(id, yield* readQueue(id));
        }
        // A later thread's start is a mailbox barrier: all guarded wakeups precede it.
        const sentinel = ThreadId.make("wakeup-sentinel");
        yield* createThread(sentinel);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* writeQueue(
              sentinel,
              yield* enqueueQueue(
                {
                  threadId: sentinel,
                  queueItemId: "qitem_sentinel",
                  text: "Sentinel",
                  attachments: [],
                },
                yield* readQueue(sentinel),
              ),
            );
          }),
        );
        expect(yield* Queue.take(starts).pipe(Effect.timeout("5 seconds"))).toBe(
          "queue:qitem_sentinel",
        );
        for (const [id, doc] of protectedQueues) expect(yield* readQueue(id)).toEqual(doc);
        expect(delivered).toEqual([...expected, "queue:qitem_sentinel"]);
      }).pipe(
        Effect.provide(
          makeTestLayer((_id, status) => {
            Queue.offerUnsafe(reads, status);
          }),
        ),
      );
    }),
);
