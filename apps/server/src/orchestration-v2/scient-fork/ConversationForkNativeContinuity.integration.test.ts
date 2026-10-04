import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
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
  makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import { EventSinkV2 } from "../EventSink.ts";
import {
  handoffCoverage,
  historicalMessage,
  historyResponseItems,
  selectHistory,
} from "../ContextHandoffBudget.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "../testkit/ReplayTranscriptNdjson.ts";
import {
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
} from "../testkit/fixtures/shared.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const projectId = ProjectId.make("scient-native-fork-project");
const sourceId = ThreadId.make("scient-native-fork-source");
const targetId = ThreadId.make("scient-native-fork-target");
const waitCompleted = Effect.fn("NativeFork.waitCompleted")(function* (
  threadId: ThreadId,
  expectedStatus: "completed" | "failed" = "completed",
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
    Stream.filter((projection) =>
      ["completed", "failed", "interrupted", "cancelled"].includes(
        projection.runs.at(-1)?.status ?? "",
      ),
    ),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.ok(Option.isSome(complete));
  assert.equal(
    complete.value.runs.at(-1)?.status,
    expectedStatus,
    encodeFrame(complete.value.turnItems.filter((item) => item.type === "error")),
  );
  return complete.value;
});

const createSource = Effect.fn("NativeFork.createSource")(function* (cwd: string) {
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
  return yield* waitCompleted(sourceId);
});

for (const scenario of [
  "unchanged",
  "deleted",
  "native-failure",
  "changed-instance",
  "appended",
  "reverted",
] as const) {
  it.live(`retained native continuity preserves the frozen prefix: ${scenario}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `scient-native-fork-continuity-${scenario}`;
        const cwd = yield* checkpointWorkspace(name);
        const recorded = yield* readProviderReplayTranscript(
          new URL(
            "../testkit/fixtures/thread_fork_native/codex_transcript.ndjson",
            import.meta.url,
          ),
        );
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(recorded, cwd),
        );
        const entries = [...transcript.entries];
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
          const source = yield* createSource(cwd);
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
                encodeFrame(sourceStart.frame).replace('"id":2', '"id":7'),
              );
              entries.splice(
                nextFork,
                entries.length - nextFork,
                {
                  type: "expect_outbound",
                  label: "thread/read/source-rollback",
                  frame: {
                    id: 5,
                    method: "thread/read",
                    params: { threadId: "native-source-thread", includeTurns: false },
                  },
                },
                {
                  type: "emit_inbound",
                  label: "thread/read/source-rollback",
                  frame: {
                    id: 5,
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
                    id: 6,
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
                    id: 6,
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
                    id: 7,
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
                (yield* orchestrator.getThreadProjection(targetId)).contextTransfers[0]
                  ?.frozenSource,
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
            assert.ok(
              (yield* orchestrator.getThreadProjection(sourceId)).thread.deletedAt !== null,
            );
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
          assert.include(target.messages.at(-1)?.text ?? "", "fork native ok");
          const repeated = yield* forks.dispatch(forkCommand);
          assert.equal(repeated.sequence, receipt.sequence);
          assert.lengthOf((yield* orchestrator.getThreadProjection(targetId)).contextTransfers, 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
}

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
          { databaseLayer, configureMcp: false },
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
          { databaseLayer, configureMcp: false, recoverOnStartup: true },
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
          frame: { id: 5, error: { code: -32000, message: "first turn rejected" } },
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
