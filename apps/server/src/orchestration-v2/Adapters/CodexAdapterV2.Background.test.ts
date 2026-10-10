import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RunAttemptId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  CommandId,
  ProjectId,
  MessageId,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner, ChildProcess } from "effect/process";
import * as IdAllocator from "../IdAllocator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { layer } from "./CodexAdapterV2.testkit.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  awaitUntil,
  CODEX_TEST_MODEL_SELECTION,
  encodeUnknownJson,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const replayTranscriptJson = Schema.fromJsonString(CodexReplay.CodexAppServerReplayTranscript);

  const encodeReplayTranscriptJson = Schema.encodeEffect(replayTranscriptJson);

  const decodeReplayTranscriptJson = Schema.decodeUnknownEffect(replayTranscriptJson);

  const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

  const BG_SCENARIO = "codex-bg-exec-wake";

  const BG_NATIVE_THREAD = "native-codex-bg-thread";

  const BG_NATIVE_TURN = "native-codex-bg-turn";

  const BG_COMMAND_ITEM = "call-codex-bg-command";

  const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";

  const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

  const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: BG_COMMAND_ITEM,
    command: BG_COMMAND,
    cwd: "/workspace",
    processId: "4242",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: BG_COMMAND }],
    aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 25_000 : null,
  });

  const backgroundExecTranscript = makeCodexReplayTranscript({
    scenario: BG_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: BG_NATIVE_THREAD,
        nativeTurnId: BG_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-bg",
              text: "STARTED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: BG_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect(
    "projects a post-settle background command completion and requests a continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(backgroundExecTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-wake"),
              text: BG_PROMPT,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isTrue(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
          );
          assert.lengthOf(harness.continuationRequests, 0);
          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");

          yield* TestClock.adjust("30 seconds");
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation request",
          );
          const request = harness.continuationRequests[0];
          assert.equal(request?.threadId, harness.threadId);
          assert.equal(request?.providerThreadId, harness.providerThread.id);
          assert.equal(request?.driver, CodexAdapterV2.CODEX_DRIVER_KIND);
          assert.deepEqual(request?.notification, {
            source: { kind: "command" },
            outcome: "completed",
            summary: `Command "${BG_COMMAND}" finished (exit 0)`,
            detail: BG_COMMAND,
          });
          assert.equal(
            request?.detail,
            `Background command completed (exit 0): ${BG_COMMAND}\n\n` +
              "Output tail:\nCODEX_BG_WAKE_DONE",
          );

          const lateCommandUpdateIndex = () =>
            harness.events.findIndex(
              (event, index) =>
                index > terminalIndex &&
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.output === "CODEX_BG_WAKE_DONE\n" &&
                event.turnItem.exitCode === 0,
            );
          yield* awaitUntil(
            () => lateCommandUpdateIndex() > terminalIndex,
            "post-settle command projection",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect.each(
    ([true, false, "still_running"] as const).flatMap((terminated) => {
      const stillRunning = terminated === "still_running";
      const transcript = makeCodexReplayTranscript({
        scenario: `codex-bg-stop-${terminated}`,
        entries: [
          ...backgroundExecTranscript.entries.slice(0, -1),
          {
            type: "expect_outbound",
            label: "terminate-background-command",
            frame: {
              id: 4,
              method: "thread/backgroundTerminals/terminate",
              params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
            },
          },
          {
            type: "emit_inbound",
            label: "terminate-background-command",
            frame: { id: 4, result: { terminated: terminated === true } },
          },
          ...(terminated !== true
            ? [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 5,
                    method: "thread/backgroundTerminals/list",
                    params: { threadId: BG_NATIVE_THREAD },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  frame: {
                    id: 5,
                    result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
                  },
                },
              ]
            : []),
          ...(stillRunning
            ? [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 6,
                    method: "thread/backgroundTerminals/terminate",
                    params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  frame: { id: 6, result: { terminated: false } },
                },
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 7,
                    method: "thread/backgroundTerminals/list",
                    params: { threadId: BG_NATIVE_THREAD },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
                },
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 8,
                    method: "thread/backgroundTerminals/terminate",
                    params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  frame: { id: 8, result: { terminated: true } },
                },
              ]
            : []),
          backgroundExecTranscript.entries.at(-1)!,
        ],
      });
      return [
        {
          caseTitle: `stops a command after root completion when termination returns ${terminated}`,
          run: () =>
            Effect.scoped(
              Effect.gen(function* () {
                const stopped = yield* Deferred.make<void>();
                const harness = yield* makeCodexReplayHarness(transcript, (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.status === "interrupted"
                    ? Deferred.succeed(stopped, undefined)
                    : Effect.void,
                );
                const now = yield* DateTime.now;
                yield* harness.runtime.startTurn(
                  makeCodexTestTurnInput({
                    threadId: harness.threadId,
                    providerThread: harness.providerThread,
                    now,
                    attemptId: RunAttemptId.make("attempt-codex-bg-stop"),
                    text: BG_PROMPT,
                  }),
                );
                yield* harness.firstTerminal;
                const terminal = harness.terminalEvents()[0]!;
                assert.equal(terminal.status, "completed");
                assert.isTrue(yield* harness.hasPendingBackgroundWork);
                assert.isFalse(
                  yield* harness.runtime.hasPendingBackgroundWorkForThread!({
                    ...harness.providerThread,
                    id: ProviderThreadId.make("unrelated-provider-thread"),
                  }),
                );
                if (stillRunning) {
                  const failed = yield* harness.runtime
                    .interruptTurn({
                      providerThread: harness.providerThread,
                      providerTurnId: terminal.providerTurnId,
                      requestRuntimeRestart: true,
                    })
                    .pipe(Effect.exit);
                  assert.equal(failed._tag, "Failure");
                  assert.isTrue(yield* harness.hasPendingBackgroundWork);
                }
                yield* harness.runtime.interruptTurn({
                  providerThread: harness.providerThread,
                  providerTurnId: stillRunning
                    ? ProviderTurnId.make("later-completed-turn")
                    : terminal.providerTurnId,
                  requestRuntimeRestart: true,
                });
                yield* Deferred.await(stopped);
                assert.isFalse(yield* harness.hasPendingBackgroundWork);
                assert.lengthOf(harness.terminalEvents(), 1);
                assert.equal(harness.terminalEvents()[0]?.status, "completed");
                assert.lengthOf(harness.continuationRequests, 0);
              }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
            ),
        },
        ...(terminated === true
          ? [
              {
                caseTitle: "interrupts a completed run's background command through orchestration",
                run: () =>
                  Effect.scoped(
                    Effect.gen(function* () {
                      const fs = yield* FileSystem.FileSystem;
                      const cwd = yield* fs.makeTempDirectoryScoped({
                        prefix: "t3-bg-stop-workspace-",
                      });
                      const localTranscript = yield* decodeReplayTranscriptJson(
                        (yield* encodeReplayTranscriptJson(transcript)).replaceAll(
                          yield* encodeStringJson("/workspace"),
                          yield* encodeStringJson(cwd),
                        ),
                      );
                      const replayDriver = yield* CodexReplay.makeReplayDriver(localTranscript);
                      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                      assert.equal(
                        Number(
                          yield* spawner.exitCode(
                            ChildProcess.make("git", ["init", "--quiet"], { cwd }),
                          ),
                        ),
                        0,
                      );
                      assert.equal(
                        Number(
                          yield* spawner.exitCode(
                            ChildProcess.make(
                              "git",
                              [
                                "-c",
                                "user.name=Test",
                                "-c",
                                "user.email=test@example.com",
                                "commit",
                                "--allow-empty",
                                "--quiet",
                                "-m",
                                "Initial commit",
                              ],
                              { cwd },
                            ),
                          ),
                        ),
                        0,
                      );
                      yield* Effect.gen(function* () {
                        const orchestrator = yield* Orchestrator.OrchestratorV2;
                        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
                        const threadId = ThreadId.make("thread:background-stop");
                        yield* orchestrator.dispatch({
                          type: "thread.create",
                          commandId: CommandId.make("create-background-stop"),
                          threadId,
                          projectId: ProjectId.make("project:background-stop"),
                          title: "Background stop",
                          modelSelection: CODEX_TEST_MODEL_SELECTION,
                          runtimeMode: "full-access",
                          interactionMode: "default",
                          branch: null,
                          worktreePath: cwd,
                          createdBy: "user",
                          creationSource: "web",
                        });
                        const waiting = yield* orchestrator.streamDomainEvents.pipe(
                          Stream.filter(
                            (event) =>
                              event.type === "run.updated" && event.payload.status === "waiting",
                          ),
                          Stream.runHead,
                          Effect.forkChild({ startImmediately: true }),
                        );
                        yield* orchestrator.dispatch({
                          type: "message.dispatch",
                          commandId: CommandId.make("start-background-stop"),
                          threadId,
                          messageId: MessageId.make("message:background-stop"),
                          text: BG_PROMPT,
                          attachments: [],
                          createdBy: "user",
                          creationSource: "web",
                          dispatchMode: { type: "start_immediately" },
                        });
                        yield* worker.drain();
                        assert.isNull((yield* Ref.get(replayDriver.state)).failure);
                        yield* Fiber.join(waiting);
                        yield* worker.drain();
                        const projection = yield* orchestrator.getThreadProjection(threadId);
                        const run = projection.runs.at(-1)!;
                        assert.equal(run.status, "completed");
                        assert.equal(
                          (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks
                            ?.length,
                          1,
                        );
                        const stopped = yield* orchestrator.streamDomainEvents.pipe(
                          Stream.filter(
                            (event) =>
                              event.type === "turn-item.updated" &&
                              event.payload.type === "command_execution" &&
                              event.payload.status === "interrupted",
                          ),
                          Stream.runHead,
                          Effect.forkChild({ startImmediately: true }),
                        );
                        yield* orchestrator.dispatch({
                          type: "run.interrupt",
                          commandId: CommandId.make("stop-background-command"),
                          threadId,
                          runId: run.id,
                        });
                        yield* worker.drain();
                        yield* Fiber.join(stopped);
                        assert.equal(
                          (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                          "completed",
                        );
                        assert.deepEqual(
                          (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
                          [],
                        );
                      }).pipe(
                        Effect.provide(
                          makeOrchestratorV2ReplayLayerWithRegistry(
                            { name: "codex-background-stop", runtimePolicyOverride: { cwd } },
                            layer({
                              transcript: localTranscript,
                              driver: replayDriver,
                            }),
                            { runEffectWorker: false },
                          ),
                        ),
                      );
                    }).pipe(Effect.provide(NodeServices.layer)),
                  ),
              },
            ]
          : []),
      ];
    }),
  )("$caseTitle", ({ run }) =>
    Effect.gen(function* () {
      yield* run();
    }),
  );

  // The app-server exits after the root turn, before the command's own
  // item/completed (Codex always sends one, so only a lost notification or a
  // gone process leaves it running). Nothing tracks the command any more, yet
  // the thread still shows it, and Stop is the only way to clear it.
  it.effect("Stop ends a background command no Codex process tracks any more", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bg-stale-workspace-" });
        const staleTranscript = makeCodexReplayTranscript({
          scenario: "codex-bg-stop-untracked",
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -1),
            { type: "runtime_exit", status: "success" },
          ],
        });
        const localTranscript = yield* decodeReplayTranscriptJson(
          (yield* encodeReplayTranscriptJson(staleTranscript)).replaceAll(
            yield* encodeStringJson("/workspace"),
            yield* encodeStringJson(cwd),
          ),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const args of [
          ["init", "--quiet"],
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial commit",
          ],
        ]) {
          assert.equal(Number(yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }))), 0);
        }
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop-untracked");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop-untracked"),
            threadId,
            projectId: ProjectId.make("project:background-stop-untracked"),
            title: "Background stop untracked",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop-untracked"),
            threadId,
            messageId: MessageId.make("message:background-stop-untracked"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(settled);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadShell(threadId);
          assert.deepEqual(
            before?.pendingBackgroundTasks?.map((task) => task.kind),
            ["command"],
            "the thread still shows the command the gone process never finished",
          );
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-untracked"),
            threadId,
            runId: run.id,
            holdQueue: true,
          });
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.type === "command_execution" ? [item.status] : [],
            ),
            ["interrupted"],
          );
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "codex-background-stop-untracked", runtimePolicyOverride: { cwd } },
              layer({ transcript: localTranscript }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";

  const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";

  const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

  const preSettleTranscript = makeCodexReplayTranscript({
    scenario: PRE_SETTLE_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
        nativeTurnId: PRE_SETTLE_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-pre-settle",
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-pre-settle",
              text: "DONE",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
          },
        },
      },
    ],
  });

  it.effect("does not request a continuation for a command that completes before settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(preSettleTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-bg-pre-settle"),
            text: BG_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.exitCode === 0,
            ),
          "pre-settle command projection",
        );

        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect.each(
    [false, true].map((rejected) => ({
      caseTitle: `preserves a newer unrelated root during a captured Stop ${rejected ? "rejection" : "success"}`,
      rejected,
    })),
  )("$caseTitle", ({ rejected }) => {
    let sessionCloses = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "captured-stop-native-thread";
        const oldNativeTurnId = "native-1";
        const newNativeTurnId = "native-2";
        const prompt = "Start an independent root.";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: oldNativeTurnId,
          prompt,
        });
        const startEntry = preamble.find(
          (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
        );
        if (startEntry?.type !== "expect_outbound" || !Predicate.isObject(startEntry.frame)) {
          return yield* Effect.die("Missing exact native turn/start replay expectation.");
        }
        const interruptRequested = yield* Deferred.make<void>();
        const responseParked = yield* Deferred.make<void>();
        const releaseResponse = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseResponse, undefined));
        const transcript = makeCodexReplayTranscript({
          scenario: `captured-stop-unrelated-root-${rejected ? "rejected" : "accepted"}`,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "captured interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: oldNativeTurnId },
              },
            },
            {
              type: "expect_outbound",
              label: "independent root start",
              frame: { ...startEntry.frame, id: 5 },
            },
            {
              type: "emit_inbound",
              label: "independent root accepted",
              frame: {
                id: 5,
                result: {
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "independent root started",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "held captured interrupt response",
              frame: rejected
                ? {
                    id: 4,
                    error: { code: -32_000, message: "captured native-1 interrupt rejected" },
                  }
                : { id: 4, result: {} },
            },
            ...(!rejected
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "old root completed",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: nativeThreadId,
                        turn: makeCodexReplayTurn({
                          id: oldNativeTurnId,
                          status: "interrupted",
                        }),
                      },
                    },
                  },
                ]
              : []),
            {
              type: "expect_outbound",
              label: "new root still steerable",
              frame: {
                id: 6,
                method: "turn/steer",
                params: {
                  threadId: nativeThreadId,
                  expectedTurnId: newNativeTurnId,
                  input: [{ type: "text", text: "Continue the independent root." }],
                },
              },
            },
            {
              type: "emit_inbound",
              label: "new root steer acknowledged",
              frame: { id: 6, result: { turnId: newNativeTurnId } },
            },
            {
              type: "emit_inbound",
              label: "new root completed normally",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const driver = yield* CodexReplay.makeReplayDriver(transcript, {
          beforeEmitInbound: (entry) =>
            entry.label === "held captured interrupt response"
              ? Deferred.succeed(responseParked, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseResponse)),
                )
              : Effect.void,
        });
        const requests: Array<{ method: string; params: unknown }> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          undefined,
          (method, params) =>
            Effect.sync(() => {
              requests.push({ method, params });
            }).pipe(
              Effect.andThen(
                method === "turn/interrupt"
                  ? Deferred.succeed(interruptRequested, undefined)
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          undefined,
          undefined,
          undefined,
          {
            replayDriver: driver,
            onSessionClose: () =>
              Effect.sync(() => {
                sessionCloses++;
              }),
          },
        );
        const oldInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("captured-stop-old-attempt"),
          text: prompt,
        });
        const newInput = {
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("captured-stop-independent-attempt"),
            text: prompt,
          }),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        };
        assert.notEqual(newInput.rootNodeId, oldInput.rootNodeId);
        assert.notEqual(newInput.runId, oldInput.runId);
        assert.isNull(newInput.appThread.lineage.parentThreadId);
        yield* harness.runtime.startTurn(oldInput);
        const providerTurns = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
              event.type === "provider_turn.updated",
          );
        yield* awaitUntil(
          () =>
            providerTurns().some(
              (event) => event.providerTurn.nativeTurnRef?.nativeId === oldNativeTurnId,
            ),
          "old native root receipt",
        );
        const oldTurn = providerTurns().find(
          (event) => event.providerTurn.nativeTurnRef?.nativeId === oldNativeTurnId,
        )!.providerTurn;
        const stopInput = {
          providerThread: harness.providerThread,
          providerTurnId: oldTurn.id,
        };
        const stopFiber = yield* harness.runtime
          .interruptTurn(stopInput)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(interruptRequested);
        const startFiber = yield* harness.runtime.startTurn(newInput).pipe(Effect.forkScoped);
        yield* Deferred.await(responseParked);
        yield* awaitUntil(
          () =>
            providerTurns().some(
              (event) => event.providerTurn.nativeTurnRef?.nativeId === newNativeTurnId,
            ),
          "new unrelated native root receipt while old response is held",
        );
        const newTurn = providerTurns().find(
          (event) => event.providerTurn.nativeTurnRef?.nativeId === newNativeTurnId,
        )!.providerTurn;
        assert.equal(newTurn.nodeId, newInput.rootNodeId);
        assert.equal(newTurn.runAttemptId, newInput.attemptId);
        assert.equal(newTurn.nativeAcceptance, "accepted");
        assert.equal(newTurn.status, "running");
        assert.equal(oldTurn.nodeId, oldInput.rootNodeId);
        assert.equal(oldTurn.runAttemptId, oldInput.attemptId);
        assert.equal(sessionCloses, 0);
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isUndefined(stopFiber.pollUnsafe());
        yield* Deferred.succeed(releaseResponse, undefined);
        yield* Fiber.join(startFiber);
        const stopExit = yield* Fiber.join(stopFiber);
        assert.equal(stopExit._tag, rejected ? "Failure" : "Success");
        if (rejected)
          assert.include(encodeUnknownJson(stopExit), "captured native-1 interrupt rejected");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "old root settlement");
        assert.equal(harness.terminalEvents()[0]?.providerTurnId, oldTurn.id);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.equal(
          providerTurns()
            .filter((event) => event.providerTurn.id === newTurn.id)
            .at(-1)?.providerTurn.status,
          "running",
        );
        const staleExit = yield* harness.runtime.interruptTurn(stopInput).pipe(Effect.exit);
        assert.equal(staleExit._tag, "Failure");
        assert.deepEqual(
          requests.filter((request) => request.method === "turn/interrupt"),
          [
            {
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: oldNativeTurnId },
            },
          ],
        );
        assert.equal(sessionCloses, 0);
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: newInput.runId,
          providerThread: harness.providerThread,
          providerTurnId: newTurn.id,
          message: { ...newInput.message, text: "Continue the independent root." },
        });
        yield* awaitUntil(
          () => harness.terminalEvents().length === 2,
          "new root normal completion",
        );
        assert.equal(harness.terminalEvents()[1]?.providerTurnId, newTurn.id);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.equal(
          providerTurns()
            .filter((event) => event.providerTurn.id === newTurn.id)
            .at(-1)?.providerTurn.status,
          "completed",
        );
        assert.equal(sessionCloses, 0);
        assert.deepEqual(yield* Ref.get(driver.state), {
          cursor: transcript.entries.length,
          failure: null,
        });
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ).pipe(Effect.tap(() => Effect.sync(() => assert.equal(sessionCloses, 1))));
  });
});
