import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ChatAttachmentId,
  CheckpointScopeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as CodexReplay from "effect-codex-app-server/replay";
import {
  CodexOrchestratorReplayHarness,
  layer as makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import { EventSinkV2 } from "../EventSink.ts";
import {
  handoffCoverage,
  historicalMessage,
  historyResponseItems,
  selectHistory,
} from "../ContextHandoffBudget.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { conversationSnapshotProjection } from "../../scient/conversationExport/conversationSnapshotProjection.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { materializeCodexOwnerReload } from "../testkit/CodexReplayOwnerReload.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "../testkit/ReplayTranscriptNdjson.ts";
import {
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
} from "../testkit/fixtures/shared.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { makeProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../../persistence/Sqlite.ts";

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const projectId = ProjectId.make("scient-native-fork-project");
const sourceId = ThreadId.make("scient-native-fork-source");
const targetId = ThreadId.make("scient-native-fork-target");
const waitCompleted = Effect.fn("NativeFork.waitCompleted")(function* (
  threadId: ThreadId,
  expectedStatus: "completed" | "failed" | "interrupted" = "completed",
  expectedRunId?: RunId,
  requireReadyCheckpoint = false,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const complete = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) => {
      const run =
        expectedRunId === undefined
          ? projection.runs.at(-1)
          : projection.runs.find((run) => run.id === expectedRunId);
      if (!run || !["completed", "failed", "interrupted", "cancelled"].includes(run.status))
        return false;
      if (!requireReadyCheckpoint) return true;
      const checkpoint = projection.checkpoints.find(
        (checkpoint) => checkpoint.id === run.checkpointId,
      );
      return (
        checkpoint?.status === "ready" &&
        checkpoint.runId === run.id &&
        projection.checkpoints.some(
          (baseline) =>
            baseline.scopeId === checkpoint.scopeId &&
            baseline.runId === null &&
            baseline.status === "ready",
        )
      );
    }),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.ok(Option.isSome(complete));
  assert.equal(
    (expectedRunId === undefined
      ? complete.value.runs.at(-1)
      : complete.value.runs.find((run) => run.id === expectedRunId)
    )?.status,
    expectedStatus,
    encodeFrame(complete.value.turnItems.filter((item) => item.type === "error")),
  );
  return complete.value;
});

const createSource = Effect.fn("NativeFork.createSource")(function* (
  cwd: string,
  expectedStatus: "completed" | "failed" | "interrupted" = "completed",
) {
  const orchestrator = yield* OrchestratorV2;
  const sink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("native-fork-project"),
    projectId,
    commandType: "project.create",
    acceptedAt: now,
    event: {
      eventId: EventId.make("native-fork-project-created"),
      type: "project.created",
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Native fork",
        workspaceRoot: cwd,
        scripts: [],
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("native-fork-source-create"),
    threadId: sourceId,
    projectId,
    title: "Source",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("native-fork-source-dispatch"),
    threadId: sourceId,
    messageId: MessageId.make("native-fork-source-message"),
    text: THREAD_FORK_NATIVE_SOURCE_PROMPT,
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return yield* waitCompleted(sourceId, expectedStatus);
});

it.live.each(
  (
    [
      "unchanged",
      "completed-reply-interrupted-run",
      "completed-reply-failed-run",
      "deleted",
      "native-failure",
      "changed-instance",
      "appended",
      "reverted",
    ] as const
  ).map((scenario) => {
    const title =
      scenario === "completed-reply-interrupted-run" || scenario === "completed-reply-failed-run"
        ? `completed durable reply admits portable continuation: ${scenario}`
        : `retained native continuity preserves the frozen prefix: ${scenario}`;

    return { caseTitle: title, scenario, title };
  }),
)("$caseTitle", ({ scenario, title }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `scient-native-fork-continuity-${scenario}`;
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
      );
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      const entries = [...transcript.entries];
      const sourceStatus =
        scenario === "completed-reply-interrupted-run"
          ? "interrupted"
          : scenario === "completed-reply-failed-run"
            ? "failed"
            : "completed";
      if (sourceStatus !== "completed") {
        // Keep the actual completed assistant item, then let the native decoder
        // and worker durably settle its owning run with the later terminal status.
        const terminalIndex = entries.findIndex(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/source",
        );
        const terminal = entries[terminalIndex];
        assert.ok(terminal?.type === "emit_inbound");
        entries[terminalIndex] = {
          ...terminal,
          frame: decodeFrame(
            encodeFrame(terminal.frame).replace(
              '"status":"completed"',
              `"status":"${sourceStatus}"`,
            ),
          ),
        };
      }
      const replayTranscript = { ...transcript, entries };
      const driver = yield* CodexReplay.makeReplayDriver(replayTranscript);
      const targetModelSelection =
        scenario === "changed-instance"
          ? { ...modelSelection, instanceId: ProviderInstanceId.make("codex-alternative") }
          : modelSelection;
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeCodexProviderAdapterRegistryReplayLayer({
          transcript: replayTranscript,
          driver,
          instanceIds: [modelSelection.instanceId, targetModelSelection.instanceId],
        }),
        { configureMcp: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const forks = yield* ConversationForkService;
        const now = yield* DateTime.now;
        const source = yield* createSource(cwd, sourceStatus);
        assert.equal(source.runs[0]?.status, sourceStatus);
        if (scenario === "native-failure") {
          const sourceRun = source.runs[0];
          const providerTurn = source.providerTurns[0];
          if (sourceRun === undefined || providerTurn === undefined)
            return assert.fail("Expected actual completed native source owner");
          yield* sink.write({
            events: [
              {
                id: EventId.make("native-fork-question-submitted"),
                type: "turn-item.updated",
                threadId: sourceId,
                runId: sourceRun.id,
                providerInstanceId: sourceRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("native-fork-submitted-question"),
                  threadId: sourceId,
                  runId: sourceRun.id,
                  nodeId: sourceRun.rootNodeId,
                  providerThreadId: providerTurn.providerThreadId,
                  providerTurnId: providerTurn.id,
                  nativeItemRef: {
                    driver: ProviderDriverKind.make("codex"),
                    nativeId: "source-question",
                    strength: "strong",
                  },
                  parentItemId: null,
                  ordinal: 100,
                  status: "completed",
                  title: "Dataset",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "user_input_request",
                  requestId: RuntimeRequestId.make("source-submitted-question"),
                  questions: [
                    { id: "dataset", header: "Dataset", question: "Which dataset?", options: [] },
                  ],
                  questionAnswer: {
                    requestId: "source-submitted-question",
                    answers: { dataset: "Measured dataset" },
                    questionTextById: { dataset: "Which dataset?" },
                    attachmentsByQuestionId: {},
                  },
                },
              },
            ],
          });
        }
        const answer = source.turnItems.find(
          (item) => item.type === "assistant_message" && item.status === "completed",
        );
        assert.ok(answer?.type === "assistant_message");
        assert.equal(answer.runId, source.runs[0]?.id);
        assert.isFalse(answer.streaming);
        assert.equal(answer.text, "source fork seed ok");
        const persistedSource = yield* (yield* ProjectionStoreV2).getThreadProjection(sourceId);
        assert.equal(persistedSource.runs[0]?.status, sourceStatus);
        assert.ok(
          persistedSource.turnItems.some(
            (item) =>
              item.id === answer.id &&
              item.status === "completed" &&
              item.type === "assistant_message" &&
              !item.streaming &&
              item.runId === answer.runId,
          ),
          "The selected completed answer must survive SQL settlement of its own run",
        );
        const forkCommand = {
          type: "thread.fork" as const,
          commandId: CommandId.make("scient-native-fork"),
          originThreadId: sourceId,
          newThreadId: targetId,
          sourceAssistantMessageId: answer.messageId,
          workspaceMode: "local" as const,
        };
        const receipt = yield* forks.dispatch(forkCommand);
        const frozen = yield* orchestrator.getThreadProjection(targetId);
        assert.lengthOf(
          frozen.contextTransfers,
          1,
          "The accepted retained fork must durably own its native continuity proof",
        );
        assert.equal(frozen.contextTransfers[0]?.status, "pending");
        if (sourceStatus !== "completed") {
          // An unsuccessful native turn cannot be cloned. Fork admission still
          // preserves its independently completed durable reply as portable history.
          assert.isUndefined(frozen.contextTransfers[0]?.frozenSource);
          assert.include(
            frozen.contextTransfers[0]?.portableReason ?? "",
            "completed native conversation",
          );
          assert.deepEqual(
            frozen.messages.map((message) => message.text),
            [THREAD_FORK_NATIVE_SOURCE_PROMPT, "source fork seed ok"],
          );
          const inheritedAnswer = frozen.visibleTurnItems.find(
            (row) => row.item.type === "assistant_message" && row.item.text === answer.text,
          )?.item;
          assert.ok(inheritedAnswer?.type === "assistant_message");
          assert.equal(inheritedAnswer.status, "completed");
          assert.isFalse(inheritedAnswer.streaming);
          assert.equal(inheritedAnswer.inheritedFrom?.runId, answer.runId);
          assert.equal(inheritedAnswer.inheritedFrom?.itemId, answer.id);
          assert.lengthOf(frozen.runs, 0);
          assert.lengthOf(frozen.providerThreads, 0, "Admission must not execute a provider");
          const repeated = yield* forks.dispatch(forkCommand);
          assert.equal(repeated.sequence, receipt.sequence);
          const reloaded = yield* (yield* ProjectionStoreV2).getThreadProjection(targetId);
          assert.lengthOf(reloaded.contextTransfers, 1);
          assert.deepEqual(reloaded.visibleTurnItems, frozen.visibleTurnItems);
          assert.equal(
            (yield* orchestrator.getThreadProjection(sourceId)).runs[0]?.status,
            sourceStatus,
          );
          assert.isNull((yield* Ref.get(driver.state)).failure);
          return;
        }
        assert.equal(
          frozen.contextTransfers[0]?.frozenSource?.providerTurnId,
          source.providerTurns[0]?.id,
          encodeFrame({
            reason: frozen.contextTransfers[0]?.portableReason,
            runs: source.runs,
            attempts: source.attempts,
            turns: source.providerTurns,
          }),
        );
        assert.lengthOf(frozen.providerThreads, 0, "A fork receipt grants no provider execution");
        if (scenario === "appended" || scenario === "reverted") {
          const forkIndex = entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
          );
          const laterTurn = entries
            .slice(forkIndex + 2)
            .filter((entry) => entry.type !== "runtime_exit")
            .map((entry) => {
              if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
              const frame: unknown = decodeFrame(
                encodeFrame(entry.frame)
                  .replaceAll("native-fork-thread", "native-source-thread")
                  .replaceAll("native-fork-turn", "native-source-later-turn")
                  .replaceAll("native-fork-user-item", "native-source-later-user-item")
                  .replaceAll("native-fork-agent-item", "native-source-later-agent-item"),
              );
              return typeof frame === "object" &&
                frame !== null &&
                "id" in frame &&
                typeof frame.id === "number"
                ? { ...entry, frame: { ...frame, id: frame.id - 1 } }
                : { ...entry, frame };
            });
          const forkAndTarget = entries.slice(forkIndex).map((entry) => {
            if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
            const frame = entry.frame;
            return typeof frame === "object" &&
              frame !== null &&
              "id" in frame &&
              typeof frame.id === "number"
              ? { ...entry, frame: { ...frame, id: frame.id + 1 } }
              : entry;
          });
          const sourceStart = entries.find(
            (entry) => entry.type === "emit_inbound" && entry.label === "thread/start/source",
          );
          assert.ok(sourceStart?.type === "emit_inbound");
          entries.splice(forkIndex, entries.length - forkIndex, ...laterTurn, ...forkAndTarget);
          const resumed = materializeCodexOwnerReload(replayTranscript, 2);
          entries.splice(0, entries.length, ...resumed.entries);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("append-source-after-freeze"),
            threadId: sourceId,
            messageId: MessageId.make("source-later-message"),
            text: THREAD_FORK_NATIVE_TARGET_PROMPT,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const advanced = yield* waitCompleted(sourceId);
          assert.lengthOf(advanced.runs, 2);
          assert.ok(
            advanced.providerTurns.some(
              (turn) => turn.nativeTurnRef?.nativeId === "native-source-later-turn",
            ),
          );
          assert.lengthOf((yield* orchestrator.getThreadProjection(targetId)).messages, 2);
          if (scenario === "reverted") {
            const nextFork = entries.findIndex(
              (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
            );
            const targetFrames = entries.slice(nextFork).map((entry) => {
              if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
              const frame = entry.frame;
              return typeof frame === "object" &&
                frame !== null &&
                "id" in frame &&
                typeof frame.id === "number"
                ? { ...entry, frame: { ...frame, id: frame.id + 3 } }
                : entry;
            });
            const revertResponse: unknown = decodeFrame(
              encodeFrame(sourceStart.frame).replace('"id":2', '"id":8'),
            );
            entries.splice(
              nextFork,
              entries.length - nextFork,
              {
                type: "expect_outbound",
                label: "thread/read/source-rollback",
                frame: {
                  id: 6,
                  method: "thread/read",
                  params: { threadId: "native-source-thread", includeTurns: false },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/read/source-rollback",
                frame: {
                  id: 6,
                  result: {
                    thread: {
                      id: "native-source-thread",
                      historyMode: "paginated",
                      status: { type: "idle" },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                label: "thread/turns/list/source-rollback",
                frame: {
                  id: 7,
                  method: "thread/turns/list",
                  params: {
                    threadId: "native-source-thread",
                    cursor: null,
                    limit: 1,
                    sortDirection: "desc",
                    itemsView: "summary",
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/turns/list/source-rollback",
                frame: {
                  id: 7,
                  result: {
                    data: [
                      {
                        id: "native-source-later-turn",
                        items: [],
                        status: "completed",
                        error: null,
                      },
                    ],
                    nextCursor: null,
                  },
                },
              },
              {
                type: "expect_outbound",
                label: "thread/revert/source-rollback",
                frame: {
                  id: 8,
                  method: "thread/revert",
                  params: {
                    threadId: "native-source-thread",
                    beforeTurnId: "native-source-later-turn",
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/revert/source-rollback",
                frame: revertResponse,
              },
              ...targetFrames,
            );
            const checkpoint = advanced.checkpoints.find(
              (candidate) => candidate.id === source.runs[0]?.checkpointId,
            );
            assert.ok(checkpoint);
            const rollbackId = CommandId.make("source-rollback-after-freeze");
            yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: rollbackId,
              threadId: sourceId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              restoreFiles: false,
            });
            const cursor = yield* orchestrator.getThreadEventSequence(sourceId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({ threadId: sourceId, afterSequence: cursor }),
            );
            const initial = yield* orchestrator.getThreadProjection(sourceId);
            const rolled = yield* Stream.concat(
              Stream.succeed(initial),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(sourceId)),
              ),
            ).pipe(
              Stream.filter(
                (projection) =>
                  projection.thread.rollbackCompletedRequestId === rollbackId ||
                  projection.thread.rollbackFailure !== null,
              ),
              Stream.runHead,
              Effect.timeout("15 seconds"),
            );
            assert.ok(Option.isSome(rolled));
            assert.isNull(rolled.value.thread.rollbackFailure);
            assert.equal(rolled.value.thread.rollbackCompletedRequestId, rollbackId);
            assert.equal(rolled.value.runs[1]?.status, "rolled_back");
            assert.equal(
              rolled.value.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
              "native-source-turn",
            );
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(targetId)).contextTransfers[0]?.frozenSource,
              frozen.contextTransfers[0]?.frozenSource,
            );
          }
        }
        if (scenario === "native-failure" || scenario === "changed-instance") {
          const forkIndex = entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
          );
          assert.ok(forkIndex > 0);
          const sourceStart = entries.find(
            (entry) => entry.type === "emit_inbound" && entry.label === "thread/start/source",
          );
          assert.ok(sourceStart?.type === "emit_inbound");
          const owned = frozen.turnItems.filter(
            (item) =>
              item.runId === null &&
              (scenario === "changed-instance" || historicalMessage(item) !== null),
          );
          const messages = owned.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          });
          assert.deepEqual(
            messages.map((message) => [message.role, message.text]),
            [
              ["user", THREAD_FORK_NATIVE_SOURCE_PROMPT],
              ["assistant", "source fork seed ok"],
              ...(scenario === "native-failure"
                ? [
                    [
                      "user",
                      historicalMessage(owned.find((item) => item.type === "user_input_request")!)
                        ?.text,
                    ],
                  ]
                : []),
            ],
          );
          const selected = selectHistory({
            messages,
            budget: 16000,
            coverage: `Context handoff (full_thread_summary):\n${handoffCoverage({ threadId: targetId, coveredRunOrdinals: { from: 1, to: 1 }, items: owned })}`,
          });
          const freshResult: unknown = decodeFrame(
            encodeFrame(sourceStart.frame)
              .replace('"id":2', '"id":5')
              .replaceAll("native-source-thread", "native-portable-thread"),
          );
          const suffix = entries.slice(forkIndex + 2).map((entry) => {
            if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
            const frame: unknown = decodeFrame(
              encodeFrame(entry.frame)
                .replace('"id":5', '"id":7')
                .replaceAll("native-fork-thread", "native-portable-thread"),
            );
            return { ...entry, frame };
          });
          entries.splice(
            forkIndex + 1,
            entries.length - forkIndex - 1,
            {
              type: "emit_inbound",
              label: "thread/fork/failure",
              frame: { id: 4, error: { code: -32000, message: "fork exploded" } },
            },
            {
              type: "expect_outbound",
              label: "thread/start/fallback",
              frame: {
                id: 5,
                method: "thread/start",
                params: { config: { "tools.update_plan.enabled": true } },
              },
            },
            { type: "emit_inbound", label: "thread/start/fallback", frame: freshResult },
            {
              type: "expect_outbound",
              label: "thread/inject_items/fallback",
              frame: {
                id: 6,
                method: "thread/inject_items",
                params: {
                  threadId: "native-portable-thread",
                  items: historyResponseItems(selected.messages, selected.context),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/inject_items/fallback",
              frame: { id: 6, result: {} },
            },
            ...suffix,
          );
          if (scenario === "changed-instance") {
            // A different configured instance opens its own real native client. It
            // receives the frozen portable prefix and never attempts a source clone.
            const portable = entries.slice(forkIndex + 2).map((entry) => {
              if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
              const frame = entry.frame;
              return typeof frame === "object" &&
                frame !== null &&
                "id" in frame &&
                typeof frame.id === "number"
                ? { ...entry, frame: { ...frame, id: frame.id - 3 } }
                : entry;
            });
            entries.splice(
              forkIndex,
              entries.length - forkIndex,
              ...entries.slice(0, 3),
              ...portable,
            );
          }
        }
        if (scenario === "deleted" || scenario === "native-failure") {
          const forkIndex = entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
          );
          const shifted = entries.slice(forkIndex).map((entry) => {
            if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
            const frame = entry.frame;
            return typeof frame === "object" &&
              frame !== null &&
              "id" in frame &&
              typeof frame.id === "number"
              ? { ...entry, frame: { ...frame, id: frame.id + 1 } }
              : entry;
          });
          entries.splice(
            forkIndex,
            entries.length - forkIndex,
            {
              type: "expect_outbound",
              label: "thread/unsubscribe/deleted-source",
              frame: {
                id: 4,
                method: "thread/unsubscribe",
                params: { threadId: "later-source-native-thread" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/unsubscribe/deleted-source",
              frame: { id: 4, result: {} },
            },
            ...shifted,
          );
          const original = source.providerThreads[0]!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("source-native-identity-mutated"),
                type: "provider-thread.updated",
                threadId: sourceId,
                occurredAt: now,
                payload: {
                  ...original,
                  nativeThreadRef: {
                    driver: original.driver,
                    nativeId: "later-source-native-thread",
                    strength: "strong",
                  },
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("native-fork-source-delete"),
            threadId: sourceId,
          });
          assert.ok((yield* orchestrator.getThreadProjection(sourceId)).thread.deletedAt !== null);
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("native-fork-target-dispatch"),
          threadId: targetId,
          messageId: MessageId.make("native-fork-target-message"),
          text: THREAD_FORK_NATIVE_TARGET_PROMPT,
          attachments: [],
          modelSelection: targetModelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const target = yield* waitCompleted(targetId).pipe(
          Effect.onExit(() =>
            Ref.get(driver.state).pipe(Effect.tap((state) => Effect.logInfo(encodeFrame(state)))),
          ),
        );
        const portable = scenario === "native-failure" || scenario === "changed-instance";
        assert.equal(
          target.providerThreads[0]?.nativeThreadRef?.nativeId,
          portable ? "native-portable-thread" : "native-fork-thread",
        );
        assert.equal(
          target.providerThreads[0]?.providerInstanceId,
          targetModelSelection.instanceId,
        );
        assert.equal(
          target.providerThreads[0]?.forkedFrom?.providerThreadId,
          portable ? undefined : source.providerThreads[0]?.id,
        );
        assert.equal(target.contextTransfers[0]?.status, "consumed");
        assert.equal(
          target.contextTransfers[0]?.resolution?.strategy,
          portable ? "portable_context" : "native_fork",
        );
        assert.lengthOf(
          target.contextHandoffs,
          portable ? 1 : 0,
          "The frozen prefix must be delivered exactly once",
        );
        if (portable) {
          assert.include(
            target.contextTransfers[0]?.portableReason ?? "",
            scenario === "native-failure"
              ? "The native fork failed:"
              : "differs from the frozen source provider scope",
          );
          assert.equal(target.contextHandoffs[0]?.delivery?.status, "injected");
          assert.deepEqual(
            target.contextHandoffs[0]?.history?.messages.map((message) => message.text),
            [
              THREAD_FORK_NATIVE_SOURCE_PROMPT,
              "source fork seed ok",
              ...(scenario === "native-failure"
                ? frozen.turnItems.flatMap((item) =>
                    item.type === "user_input_request" ? [historicalMessage(item)?.text] : [],
                  )
                : []),
            ],
          );
          if (scenario === "native-failure") {
            assert.include(
              target.contextHandoffs[0]?.history?.messages.at(-1)?.text ?? "",
              "Which dataset?",
            );
            assert.include(
              target.contextHandoffs[0]?.history?.messages.at(-1)?.text ?? "",
              "Measured dataset",
            );
          }
        }
        if (scenario === "changed-instance") {
          const localHandoffs = target.visibleTurnItems.filter(
            (row) => row.visibility === "local" && row.item.type === "handoff",
          );
          assert.lengthOf(localHandoffs, 1);
          const handoff = localHandoffs[0]?.item;
          assert.ok(handoff?.type === "handoff");
          const transfer = target.contextTransfers.find((candidate) => candidate.type === "fork");
          assert.ok(transfer?.resolution?.strategy === "portable_context");
          assert.equal(transfer.targetThreadId, handoff.threadId);
          assert.equal(transfer.targetRunId, handoff.runId);
          assert.equal(transfer.resolution.contextHandoffId, handoff.contextHandoffId);
          const reloaded = yield* orchestrator.getThreadProjection(targetId);
          assert.deepEqual(
            reloaded.turnItems.find((item) => item.id === handoff.id),
            handoff,
          );
          assert.deepEqual(
            reloaded.contextTransfers.find((candidate) => candidate.id === transfer.id),
            transfer,
          );
          assert.equal(
            reloaded.contextHandoffs.find((context) => context.id === handoff.contextHandoffId)
              ?.delivery?.status,
            "injected",
          );
        }
        assert.include(target.messages.at(-1)?.text ?? "", "fork native ok");
        const repeated = yield* forks.dispatch(forkCommand);
        assert.equal(repeated.sequence, receipt.sequence);
        assert.lengthOf((yield* orchestrator.getThreadProjection(targetId)).contextTransfers, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live(
  "reopens file-backed SQL and consumes the receipt's exact native boundary after source deletion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "scient-native-fork-restart";
        const cwd = yield* checkpointWorkspace(name);
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-native-fork-restart-",
        });
        const databaseLayer = makeSqlitePersistenceLive(`${stateDir}/statev2.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const recorded = yield* readProviderReplayTranscript(
          new URL(
            "../testkit/fixtures/thread_fork_native/codex_transcript.ndjson",
            import.meta.url,
          ),
        );
        const decoded = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(recorded, cwd),
        );
        const boundary = decoded.entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
        );
        assert.isAbove(boundary, 0);
        const before = {
          ...decoded,
          entries: [
            ...decoded.entries.slice(0, boundary),
            {
              type: "expect_outbound" as const,
              label: "thread/unsubscribe/source",
              frame: {
                id: 4,
                method: "thread/unsubscribe",
                params: { threadId: "native-source-thread" },
              },
            },
            {
              type: "emit_inbound" as const,
              label: "thread/unsubscribe/source",
              frame: { id: 4, result: {} },
            },
          ],
        };
        const beforeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(before),
          { layerDatabase: databaseLayer, configureMcp: false },
        );
        const accepted = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const forks = yield* ConversationForkService;
            const source = yield* createSource(cwd);
            const answer = source.turnItems.find(
              (item) => item.type === "assistant_message" && item.status === "completed",
            );
            assert.ok(answer?.type === "assistant_message");
            const command = {
              type: "thread.fork" as const,
              commandId: CommandId.make("native-fork-restart-receipt"),
              originThreadId: sourceId,
              newThreadId: targetId,
              sourceAssistantMessageId: answer.messageId,
              workspaceMode: "local" as const,
            };
            const receipt = yield* forks.dispatch(command);
            yield* orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("native-fork-restart-delete"),
              threadId: sourceId,
            });
            return { command, receipt };
          }).pipe(Effect.provide(beforeLayer)),
        );

        const after = {
          ...decoded,
          entries: [
            ...decoded.entries.slice(0, 3),
            ...decoded.entries.slice(boundary).map((entry) => {
              if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
              const frame = entry.frame;
              return typeof frame === "object" &&
                frame !== null &&
                "id" in frame &&
                typeof frame.id === "number"
                ? { ...entry, frame: { ...frame, id: frame.id - 2 } }
                : entry;
            }),
          ],
        };
        const afterLayer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(after),
          { layerDatabase: databaseLayer, configureMcp: false, recoverOnStartup: true },
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const forks = yield* ConversationForkService;
            const frozen = yield* orchestrator.getThreadProjection(targetId);
            assert.equal(
              frozen.contextTransfers[0]?.frozenSource?.sourceProviderTurns.at(-1)?.nativeTurnRef
                ?.nativeId,
              "native-source-turn",
            );
            assert.equal(
              (yield* forks.dispatch(accepted.command)).sequence,
              accepted.receipt.sequence,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("native-fork-restart-target"),
              threadId: targetId,
              messageId: MessageId.make("native-fork-restart-message"),
              text: THREAD_FORK_NATIVE_TARGET_PROMPT,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const target = yield* waitCompleted(targetId);
            assert.equal(
              target.providerThreads[0]?.nativeThreadRef?.nativeId,
              "native-fork-thread",
            );
            assert.equal(target.contextTransfers[0]?.resolution?.strategy, "native_fork");
            assert.lengthOf(target.contextHandoffs, 0);
            assert.lengthOf(target.providerThreads, 1);
          }).pipe(Effect.provide(afterLayer)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.live("a failed first turn retries the persisted clone instead of forking again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "scient-native-fork-first-turn-retry";
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
      );
      const decoded = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      const entries = [...decoded.entries];
      const transcript = { ...decoded, entries };
      const driver = yield* CodexReplay.makeReplayDriver(transcript);
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
        { configureMcp: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const forks = yield* ConversationForkService;
        const source = yield* createSource(cwd);
        const answer = source.turnItems.find(
          (item) => item.type === "assistant_message" && item.status === "completed",
        );
        assert.ok(answer?.type === "assistant_message");
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("first-turn-retry-fork"),
          originThreadId: sourceId,
          newThreadId: targetId,
          sourceAssistantMessageId: answer.messageId,
          workspaceMode: "local",
        });
        const forkIndex = entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
        );
        const retryFrames = entries.slice(forkIndex + 2).map((entry) => {
          if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
          const frame: unknown = decodeFrame(encodeFrame(entry.frame).replace('"id":5', '"id":7'));
          return { ...entry, frame };
        });
        const forkResponse = entries[forkIndex + 1];
        assert.ok(forkResponse?.type === "emit_inbound");
        // Control only the native app-server response; the actual adapter and run
        // execution machinery must terminalize the rejected first turn.
        entries.splice(forkIndex + 3, entries.length - forkIndex - 3, {
          type: "emit_inbound",
          label: "turn/start/fork/rejected",
          frame: { id: 5, error: { code: -32602, message: "first turn rejected" } },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first-turn-rejected"),
          threadId: targetId,
          messageId: MessageId.make("first-rejected-message"),
          text: THREAD_FORK_NATIVE_TARGET_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const failed = yield* waitCompleted(targetId, "failed");
        assert.isFalse(
          failed.providerTurns.some((turn) => turn.acceptedAt !== undefined),
          "A rejected native request creates no accepted history delivery receipt",
        );
        assert.isTrue(
          failed.providerTurns.every((turn) => turn.nativeAcceptance === "pending"),
          "The native request rejection is definite, not an uncertain transport failure",
        );
        assert.equal(failed.contextTransfers[0]?.status, "consumed");
        assert.equal(failed.contextTransfers[0]?.resolution?.strategy, "native_fork");
        assert.equal(failed.providerThreads[0]?.nativeThreadRef?.nativeId, "native-fork-thread");
        assert.lengthOf(failed.contextHandoffs, 0);
        const failedRun = failed.runs[0]!;
        const missed = failed.turnItems.filter(
          (item) => item.runId === failedRun.id && historicalMessage(item) !== null,
        );
        const messages = missed.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null ? [] : [{ ...message, runStatus: failedRun.status }];
        });
        assert.equal(messages[0]?.text, THREAD_FORK_NATIVE_TARGET_PROMPT);
        assert.ok(
          messages.every(
            (message) => message.threadId === targetId && message.runId === failedRun.id,
          ),
        );
        const selected = selectHistory({
          messages,
          budget: 16000,
          coverage: `Context handoff (delta_since_target_last_seen):\n${handoffCoverage({ threadId: targetId, coveredRunOrdinals: { from: 1, to: 1 }, items: missed })}`,
        });
        entries.push(
          {
            type: "expect_outbound",
            label: "thread/inject_items/rejected-turn",
            frame: {
              id: 6,
              method: "thread/inject_items",
              params: {
                threadId: "native-fork-thread",
                items: historyResponseItems(selected.messages, selected.context),
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/inject_items/rejected-turn",
            frame: { id: 6, result: {} },
          },
          ...retryFrames,
        );
        const resumed = materializeCodexOwnerReload(transcript, 3, {
          beforeEntryLabel: "thread/inject_items/rejected-turn",
        });
        entries.splice(0, entries.length, ...resumed.entries);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first-turn-retry"),
          threadId: targetId,
          messageId: MessageId.make("first-retry-message"),
          text: THREAD_FORK_NATIVE_TARGET_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const recovered = yield* waitCompleted(targetId).pipe(
          Effect.onExit(() =>
            Ref.get(driver.state).pipe(Effect.tap((state) => Effect.logInfo(encodeFrame(state)))),
          ),
        );
        assert.lengthOf(recovered.providerThreads, 1);
        assert.equal(recovered.providerThreads[0]?.id, failed.providerThreads[0]?.id);
        assert.equal(recovered.providerThreads[0]?.nativeThreadRef?.nativeId, "native-fork-thread");
        assert.lengthOf(
          recovered.contextTransfers.filter((transfer) => transfer.type === "fork"),
          1,
        );
        assert.equal(recovered.contextTransfers[0]?.resolution?.strategy, "native_fork");
        assert.lengthOf(recovered.runs, 2);
        assert.equal(recovered.runs[0]?.status, "failed");
        assert.equal(recovered.runs[1]?.status, "completed");
        assert.lengthOf(
          recovered.contextHandoffs,
          1,
          "Only the rejected target turn needs recovery; source prefix must not be replayed",
        );
        assert.ok(
          recovered.contextHandoffs[0]?.history?.messages.every(
            (message) => message.runId === failedRun.id,
          ),
        );
        assert.isNull((yield* Ref.get(driver.state)).failure);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.live.each(
  [false, true].map((queuedAttachment) => ({
    caseTitle: queuedAttachment
      ? "native rollback retains a held queued attachment through history pruning and replay"
      : "native baseline rollback preserves a Scient fork's inherited transcript, work log and lineage",
    queuedAttachment,
  })),
)("$caseTitle", ({ queuedAttachment }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `scient-fork-baseline-rollback-${queuedAttachment}`;
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
      );
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      const entries = [...transcript.entries];
      const sourceTerminalIndex = entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/source",
      );
      assert.isAbove(sourceTerminalIndex, 0);
      entries.splice(sourceTerminalIndex, 0, {
        type: "emit_inbound",
        label: "item/completed/source-work-log",
        frame: {
          method: "item/completed",
          params: {
            threadId: "native-source-thread",
            turnId: "native-source-turn",
            item: {
              type: "commandExecution",
              id: "native-source-work-log",
              pluginId: null,
              scriptPath: null,
              command: "echo inherited evidence",
              cwd,
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [],
              aggregatedOutput: "inherited evidence",
              exitCode: 0,
              durationMs: 1,
            },
          },
        },
      });
      const nativeFork = entries.find(
        (entry) => entry.type === "emit_inbound" && entry.label === "thread/fork",
      );
      assert.ok(nativeFork?.type === "emit_inbound");
      const revertedFrame = decodeFrame(encodeFrame(nativeFork.frame).replace('"id":4', '"id":8'));
      const exitIndex = entries.findIndex((entry) => entry.type === "runtime_exit");
      assert.isAbove(exitIndex, 0);
      entries.splice(
        exitIndex,
        0,
        {
          type: "expect_outbound",
          label: "thread/read/fork-rollback",
          frame: {
            id: 6,
            method: "thread/read",
            params: { threadId: "native-fork-thread", includeTurns: false },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/read/fork-rollback",
          frame: {
            id: 6,
            result: {
              thread: {
                id: "native-fork-thread",
                historyMode: "paginated",
                status: { type: "idle" },
              },
            },
          },
        },
        {
          type: "expect_outbound",
          label: "thread/turns/list/fork-rollback",
          frame: {
            id: 7,
            method: "thread/turns/list",
            params: {
              threadId: "native-fork-thread",
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/turns/list/fork-rollback",
          frame: {
            id: 7,
            result: {
              data: [{ id: "native-fork-turn", items: [], status: "completed", error: null }],
              nextCursor: null,
            },
          },
        },
        {
          type: "expect_outbound",
          label: "thread/revert/fork-baseline",
          frame: {
            id: 8,
            method: "thread/revert",
            params: { threadId: "native-fork-thread", beforeTurnId: "native-fork-turn" },
          },
        },
        { type: "emit_inbound", label: "thread/revert/fork-baseline", frame: revertedFrame },
      );
      const replayTranscript = { ...transcript, entries };
      const gate = makeProviderReplayGate(queuedAttachment ? ["turn/completed/fork"] : []);
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
      if (queuedAttachment) {
        const terminal = entries.find(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/fork",
        );
        assert.ok(terminal?.type === "emit_inbound");
        const encoded = encodeFrame(terminal.frame);
        entries[entries.indexOf(terminal)] = {
          ...terminal,
          frame: decodeFrame(encoded.replace('"status":"completed"', '"status":"interrupted"')),
        };
      }
      const driver = yield* CodexReplay.makeReplayDriver(replayTranscript, {
        beforeEmitInbound: (entry) =>
          Effect.promise((signal) => gate.beforeEmit(entry.label, signal)),
      });
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeCodexProviderAdapterRegistryReplayLayer({ transcript: replayTranscript, driver }),
        { configureMcp: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStoreV2;
        const source = yield* createSource(cwd);
        assert.ok(source.visibleTurnItems.some((row) => row.item.type === "command_execution"));
        const sourceAnswer = source.messages.findLast((message) => message.role === "assistant");
        assert.ok(sourceAnswer);
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("scient-rollback-fork"),
          originThreadId: sourceId,
          newThreadId: targetId,
          sourceAssistantMessageId: sourceAnswer.id,
          workspaceMode: "local",
        });
        const frozen = yield* store.getThreadProjection(targetId);
        const inheritedActivity = (yield* store.getTimelinePage(targetId, {
          view: "activity",
          limit: 100,
        })).items;
        const baselineExport = conversationSnapshotProjection(frozen, cwd).messages;
        assert.lengthOf(frozen.runs, 0);
        assert.ok(inheritedActivity.some((row) => row.item.type === "command_execution"));
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("scient-rollback-local-send"),
          threadId: targetId,
          messageId: MessageId.make("scient-rollback-local-message"),
          text: THREAD_FORK_NATIVE_TARGET_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        let queuedFile: { path: string; id: ChatAttachmentId } | undefined;
        if (queuedAttachment) {
          assert.isTrue(
            yield* Effect.promise(() => gate.waitForReached("turn/completed/fork")).pipe(
              Effect.timeout("15 seconds"),
            ),
          );
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig;
          const id = ChatAttachmentId.make(createAttachmentId(targetId)!);
          const attachment = {
            type: "file" as const,
            id,
            name: "queued.txt",
            mimeType: "text/plain",
            sizeBytes: 6,
          };
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          assert.ok(path);
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fs.writeFileString(path, "queued");
          queuedFile = { path, id };
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("rollback-queue-admission"),
            threadId: targetId,
            messageId: MessageId.make("rollback-queued-message"),
            text: "Retained queued payload",
            attachments: [attachment],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          gate.release("turn/completed/fork");
        }
        const executed = yield* waitCompleted(
          targetId,
          queuedAttachment ? "interrupted" : "completed",
          (yield* store.getThreadProjection(targetId)).runs[0]!.id,
          true,
        );
        const local = executed.runs[0];
        assert.ok(local);
        assert.isNotNull(local.rootNodeId);
        assert.isNotNull(local.activeAttemptId);
        assert.isNotNull(local.providerThreadId);
        assert.isNotNull(local.checkpointId);
        assert.lengthOf(
          executed.providerTurns.filter((turn) => turn.runAttemptId === local.activeAttemptId),
          1,
        );
        const localAttempt = executed.attempts.find(
          (attempt) => attempt.id === local.activeAttemptId,
        );
        const nativeTurn = executed.providerTurns.find(
          (turn) => turn.runAttemptId === localAttempt?.id,
        );
        assert.equal(localAttempt?.status, queuedAttachment ? "interrupted" : "completed");
        assert.equal(nativeTurn?.nativeTurnRef?.nativeId, "native-fork-turn");
        assert.include(
          conversationSnapshotProjection(executed, cwd).messages.map((message) => message.text),
          THREAD_FORK_NATIVE_TARGET_PROMPT,
        );
        const baseline = (yield* store.getThreadProjection(targetId)).checkpoints.find(
          (checkpoint) => checkpoint.runId === null && checkpoint.status === "ready",
        );
        assert.ok(baseline);
        const checkpoint = executed.checkpoints.find((entry) => entry.id === local.checkpointId);
        assert.ok(checkpoint);
        assert.equal(checkpoint.status, "ready");
        assert.equal(checkpoint.runId, local.id);
        assert.equal(checkpoint.scopeId, baseline.scopeId);
        const checkpointScope = executed.checkpointScopes.find(
          (scope) => scope.id === checkpoint.scopeId,
        );
        assert.ok(checkpointScope);
        assert.equal(checkpointScope.cwd, cwd);
        const checkpointStore = yield* CheckpointStore;
        for (const ref of [checkpoint.ref, baseline.ref]) {
          assert.isTrue(
            yield* checkpointStore.hasCheckpointRef({
              cwd: checkpointScope.cwd,
              checkpointRef: ref,
            }),
          );
        }
        if (queuedFile) {
          const rejected = yield* Effect.result(
            orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: CommandId.make("rollback-reject-wrong-scope"),
              threadId: targetId,
              checkpointId: baseline.id,
              scopeId: CheckpointScopeId.make("wrong-scope"),
              restoreFiles: false,
            }),
          );
          assert.equal(rejected._tag, "Failure");
          assert.equal(
            yield* (yield* FileSystem.FileSystem).readFileString(queuedFile.path),
            "queued",
          );
          assert.deepEqual(
            (yield* store.getThreadProjection(targetId)).messages.find(
              (message) => message.id === MessageId.make("rollback-queued-message"),
            ),
            executed.messages.find(
              (message) => message.id === MessageId.make("rollback-queued-message"),
            ),
          );
        }
        const rollbackId = CommandId.make("scient-rollback-to-baseline");
        const cursor = yield* orchestrator.getThreadEventSequence(targetId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId: targetId, afterSequence: cursor }),
        );
        const receipt = yield* orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId: rollbackId,
          threadId: targetId,
          checkpointId: baseline.id,
          scopeId: baseline.scopeId,
          restoreFiles: false,
        });
        const observed = yield* Stream.concat(
          Stream.succeed(yield* store.getThreadProjection(targetId)),
          Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(() => store.getThreadProjection(targetId)),
          ),
        ).pipe(
          Stream.filter(
            (projection) =>
              projection.thread.rollbackCompletedRequestId === rollbackId ||
              projection.thread.rollbackFailure !== null,
          ),
          Stream.runHead,
          Effect.timeout("15 seconds"),
        );
        assert.ok(Option.isSome(observed));
        const reverted = observed.value;
        assert.isNull(reverted.thread.rollbackFailure);
        assert.equal(reverted.thread.rollbackCompletedRequestId, rollbackId);
        assert.equal(
          (yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: rollbackId,
            threadId: targetId,
            checkpointId: baseline.id,
            scopeId: baseline.scopeId,
            restoreFiles: false,
          })).sequence,
          receipt.sequence,
        );
        assert.equal(reverted.runs.find((run) => run.id === local.id)?.status, "rolled_back");
        assert.equal(
          reverted.nodes.find((node) => node.id === local.rootNodeId)?.status,
          "rolled_back",
        );
        assert.equal(
          reverted.providerTurns.find((turn) => turn.id === nativeTurn?.id)?.runAttemptId,
          local.activeAttemptId,
        );
        assert.equal(
          reverted.attempts.find((attempt) => attempt.id === local.activeAttemptId)?.status,
          queuedAttachment ? "interrupted" : "completed",
        );
        assert.equal(
          reverted.checkpoints.find((checkpoint) => checkpoint.id === local.checkpointId)?.status,
          "stale",
        );
        assert.equal(
          reverted.checkpoints.find((checkpoint) => checkpoint.id === baseline.id)?.status,
          "ready",
        );
        const owner = reverted.providerThreads.find(
          (thread) => thread.id === local.providerThreadId,
        );
        assert.equal(owner?.nativeThreadRef?.nativeId, "native-fork-thread");
        assert.isNull(owner?.lastRunOrdinal);
        assert.isNull(owner?.nativeConversationHeadRef);
        if (!queuedAttachment) {
          assert.deepEqual(conversationSnapshotProjection(reverted, cwd).messages, baselineExport);
          assert.deepEqual(reverted.visibleTurnItems, frozen.visibleTurnItems);
        } else {
          assert.ok(queuedFile);
          const queued = reverted.runs.find(
            (run) => run.userMessageId === MessageId.make("rollback-queued-message"),
          );
          assert.ok(queued);
          assert.equal(queued.status, "queued");
          assert.isTrue(queued.queueHeld);
          const originalQueued = executed.messages.find(
            (message) => message.id === queued.userMessageId,
          );
          assert.ok(originalQueued);
          assert.deepEqual(
            reverted.messages.find((message) => message.id === queued.userMessageId),
            originalQueued,
          );
          assert.equal(
            yield* (yield* FileSystem.FileSystem).readFileString(queuedFile.path),
            "queued",
          );
          assert.include(
            originalQueued.attachments.map((attachment) => attachment.id),
            queuedFile.id,
          );
          assert.deepEqual(
            reverted.visibleTurnItems.filter((row) => row.item.runId !== queued.id),
            frozen.visibleTurnItems,
          );
        }
        assert.deepEqual(
          (yield* store.getTimelinePage(targetId, {
            view: "activity",
            limit: 100,
          })).items.filter(
            (row) =>
              !queuedAttachment ||
              row.item.runId !== reverted.runs.find((run) => run.status === "queued")?.id,
          ),
          inheritedActivity,
        );
        assert.deepEqual(reverted.thread.forkLineage, frozen.thread.forkLineage);
        assert.deepEqual(
          (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === targetId)
            ?.forkLineage,
          frozen.thread.forkLineage,
        );
        assert.deepEqual(
          (yield* store.getThreadProjection(sourceId)).visibleTurnItems,
          source.visibleTurnItems,
        );
        const replayState = yield* Ref.get(driver.state);
        assert.isNull(replayState.failure);
        assert.equal(replayState.cursor, entries.length);
      }).pipe(Effect.ensuring(Effect.sync(() => gate.releaseAll())), Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
