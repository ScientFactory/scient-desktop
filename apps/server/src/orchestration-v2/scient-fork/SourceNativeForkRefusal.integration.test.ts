import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
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
  return yield* waitCompleted(sourceId, expectedStatus, undefined, true);
});

// Controlled protocol replay: this deliberately invalid native response is not
// vendor qualification. Original recording bytes and all terminal frames stay intact.
it.live(
  "refuses a source-ID native fork and delivers its frozen prefix once to a fresh portable destination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "scient-source-native-fork-refusal";
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
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          makeCodexProviderAdapterRegistryReplayLayer({ transcript: replayTranscript, driver }),
          { configureMcp: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const forks = yield* ConversationForkService;
          const source = yield* createSource(cwd);
          const answer = source.turnItems.find(
            (item) => item.type === "assistant_message" && item.text === "source fork seed ok",
          );
          assert.ok(
            answer?.type === "assistant_message" &&
              !answer.streaming &&
              answer.status === "completed",
          );
          assert.equal(
            source.providerThreads[0]?.nativeThreadRef?.nativeId,
            "native-source-thread",
          );
          const forkCommand = {
            type: "thread.fork" as const,
            commandId: CommandId.make("source-id-fork"),
            originThreadId: sourceId,
            newThreadId: targetId,
            sourceAssistantMessageId: answer.messageId,
            workspaceMode: "local" as const,
          };
          const receipt = yield* forks.dispatch(forkCommand);
          const frozen = yield* orchestrator.getThreadProjection(targetId);
          assert.lengthOf(frozen.runs, 0);
          assert.lengthOf(frozen.providerThreads, 0, "Fork admission must not execute a provider");
          assert.lengthOf(frozen.contextTransfers, 1);
          assert.equal(frozen.contextTransfers[0]?.status, "pending");
          assert.equal(
            frozen.contextTransfers[0]?.frozenSource?.providerTurnId,
            source.providerTurns[0]?.id,
          );
          const owned = frozen.turnItems.filter(
            (item) => item.runId === null && historicalMessage(item) !== null,
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
            ],
          );
          const selected = selectHistory({
            messages,
            budget: 16000,
            coverage: `Context handoff (full_thread_summary):\n${handoffCoverage({ threadId: targetId, coveredRunOrdinals: { from: 1, to: 1 }, items: owned })}`,
          });
          const forkIndex = entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
          );
          const forkResponse = entries[forkIndex + 1];
          const sourceStart = entries.find(
            (entry) => entry.type === "emit_inbound" && entry.label === "thread/start/source",
          );
          assert.ok(
            forkIndex > 0 &&
              forkResponse?.type === "emit_inbound" &&
              sourceStart?.type === "emit_inbound",
          );
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
              ...forkResponse,
              label: "thread/fork/source-id",
              frame: decodeFrame(
                encodeFrame(forkResponse.frame).replaceAll(
                  "native-fork-thread",
                  "native-source-thread",
                ),
              ),
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
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("source-id-target-dispatch"),
            threadId: targetId,
            messageId: MessageId.make("source-id-target-message"),
            text: THREAD_FORK_NATIVE_TARGET_PROMPT,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const target = yield* waitCompleted(targetId, "completed", undefined, true);
          assert.lengthOf(target.runs, 1);
          assert.lengthOf(target.providerTurns, 1);
          assert.equal(
            target.providerThreads[0]?.nativeThreadRef?.nativeId,
            "native-portable-thread",
          );
          assert.isNull(target.providerThreads[0]?.forkedFrom);
          assert.equal(target.contextTransfers[0]?.status, "consumed");
          assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
          assert.include(
            target.contextTransfers[0]?.portableReason ?? "",
            "The native fork failed:",
          );
          assert.lengthOf(target.contextHandoffs, 1);
          assert.equal(target.contextHandoffs[0]?.delivery?.status, "injected");
          assert.deepEqual(
            target.contextHandoffs[0]?.history?.messages.map((message) => message.text),
            [THREAD_FORK_NATIVE_SOURCE_PROMPT, "source fork seed ok"],
          );
          assert.include(target.messages.at(-1)?.text ?? "", "fork native ok");
          const after = yield* orchestrator.getThreadProjection(sourceId);
          assert.deepEqual(
            after.providerThreads,
            source.providerThreads,
            "Invalid response must not adopt or rewrite source ownership",
          );
          assert.deepEqual(after.providerTurns, source.providerTurns);
          assert.deepEqual(after.runs, source.runs);
          assert.deepEqual(after.attempts, source.attempts);
          assert.deepEqual(after.messages, source.messages);
          const repeated = yield* forks.dispatch(forkCommand);
          assert.equal(repeated.sequence, receipt.sequence);
          const stored = yield* (yield* ProjectionStoreV2).getThreadProjection(targetId);
          assert.lengthOf(stored.contextTransfers, 1);
          assert.lengthOf(stored.contextHandoffs, 1);
          assert.lengthOf(stored.runs, 1);
          assert.deepEqual(stored.contextHandoffs, target.contextHandoffs);
          const replayState = yield* Ref.get(driver.state);
          assert.isNull(
            replayState.failure,
            "Every native request must match the strict transcript: no source revert/resume/prompt",
          );
          assert.equal(
            replayState.cursor,
            entries.length,
            "The portable terminal must consume the complete strict transcript",
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
