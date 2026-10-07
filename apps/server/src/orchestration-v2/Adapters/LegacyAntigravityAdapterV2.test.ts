// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AntigravitySettings,
  CheckpointId,
  RuntimeRequestId,
  type ChatAttachment,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeLegacyAntigravityAdapterV2 } from "./LegacyAntigravityAdapterV2.ts";

const decodeSettings = Schema.decodeEffect(AntigravitySettings);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-agy-v2-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const setupNative = Effect.fnUntraced(function* (
  suffix: string,
  sharedAdapter?: ReturnType<typeof makeLegacyAntigravityAdapterV2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const binary = path.join(config.stateDir, `agy-${suffix}`);
  const argumentsPath = path.join(config.stateDir, `launch-arguments-${suffix}.txt`);
  const pidPath = path.join(config.stateDir, `child-pids-${suffix}.txt`);
  const mockPath = NodeURL.fileURLToPath(
    new URL("../../../scripts/agy-stream-mock.ts", import.meta.url),
  );
  yield* fs.writeFileString(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(argumentsPath)}\nprintf '%s\\n' "$$" >> ${quote(pidPath)}\nexec ${quote(process.execPath)} ${quote(mockPath)} "$@"\n`,
  );
  yield* fs.chmod(binary, 0o755);
  const instanceId = ProviderInstanceId.make("agy-v2-test");
  const threadId = ThreadId.make(`agy-v2-thread-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "mock-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const runtimePolicy = {
    cwd: config.stateDir,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
  const adapter =
    sharedAdapter ??
    makeLegacyAntigravityAdapterV2({
      instanceId,
      settings: yield* decodeSettings({ enabled: true, binaryPath: binary }),
      environment: {},
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fileSystem: fs,
      path,
      serverConfig: config,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      continuations: {
        offer: () => Effect.die("An idle process failure must not wake a synthetic turn"),
      },
    });

  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`agy-session-${suffix}`),
    modelSelection,
    runtimePolicy,
  });
  const initialThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const recorded: ProviderAdapter.ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        recorded.push(event);
        yield* Queue.offer(events, event);
      }),
    ),
    Effect.forkScoped,
  );
  const takeUntil = Effect.fnUntraced(function* (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(events);
      if (predicate(event)) return event;
    }
  });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("agy-v2-project"),
    title: "Antigravity parity",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
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
  const turnInput = (
    ordinal: number,
    text: string,
    attachments: ReadonlyArray<ChatAttachment> = [],
  ) => ({
    appThread,
    threadId,
    providerThread: initialThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make(`agy-run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`agy-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`agy-root-${ordinal}`),
    message: {
      messageId: MessageId.make(`agy-message-${ordinal}`),
      text,
      attachments,
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
  });
  const start = (ordinal: number, text: string, attachments: ReadonlyArray<ChatAttachment> = []) =>
    runtime.startTurn(turnInput(ordinal, text, attachments));

  const terminal = () => takeUntil((event) => event.type === "turn.terminal");
  const textFor = (ordinal: number) =>
    recorded
      .flatMap((event) =>
        event.type === "message.updated" && event.message.runId === RunId.make(`agy-run-${ordinal}`)
          ? [event.message]
          : [],
      )
      .at(-1)?.text;
  return {
    fs,
    path,
    config,
    adapter,
    runtime,
    initialThread,
    start,
    turnInput,
    terminal,
    takeUntil,
    recorded,
    textFor,
    pidPath,
    threadId,
    modelSelection,
  };
});

it.layer(TestLayer, { excludeTestServices: true })("LegacyAntigravityAdapterV2", (it) => {
  it.effect(
    "retains resume policy and observes replacement-process failure through real native events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const binary = path.join(config.stateDir, "agy");
          const argumentsPath = path.join(config.stateDir, "launch-arguments.txt");
          const pidPath = path.join(config.stateDir, "child-pids.txt");
          const mockPath = NodeURL.fileURLToPath(
            new URL("../../../scripts/agy-stream-mock.ts", import.meta.url),
          );
          yield* fs.writeFileString(
            binary,
            `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(argumentsPath)}\nprintf '%s\\n' "$$" >> ${quote(pidPath)}\nexec ${quote(process.execPath)} ${quote(mockPath)} "$@"\n`,
          );
          yield* fs.chmod(binary, 0o755);
          const instanceId = ProviderInstanceId.make("agy-v2-test");
          const threadId = ThreadId.make("agy-v2-thread");
          const modelSelection = {
            instanceId,
            model: "mock-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          const runtimePolicy = {
            cwd: config.stateDir,
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
          };
          const adapter = makeLegacyAntigravityAdapterV2({
            instanceId,
            settings: yield* decodeSettings({ enabled: true, binaryPath: binary }),
            environment: {},
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem: fs,
            path,
            serverConfig: config,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            continuations: {
              offer: () => Effect.die("An idle process failure must not wake a synthetic turn"),
            },
          });
          assert.isFalse(adapter.mcpSessionInjection);
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("agy-v2-session"),
            modelSelection,
            runtimePolicy,
          });
          const initialThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          assert.isNull(initialThread.nativeThreadRef);
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const takeUntil = (
            predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
          ) =>
            Effect.gen(function* () {
              while (true) {
                const event = yield* Queue.take(events);
                if (predicate(event)) return event;
              }
            });
          const now = yield* DateTime.now;
          const appThread: OrchestrationV2AppThread = {
            id: threadId,
            projectId: ProjectId.make("agy-v2-project"),
            title: "Antigravity parity",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
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
          const start = (ordinal: number, providerThread: typeof initialThread) =>
            runtime.startTurn({
              appThread,
              threadId,
              providerThread,
              modelSelection,
              runtimePolicy,
              runId: RunId.make(`agy-run-${ordinal}`),
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId: RunAttemptId.make(`agy-attempt-${ordinal}`),
              rootNodeId: NodeId.make(`agy-root-${ordinal}`),
              message: {
                messageId: MessageId.make(`agy-message-${ordinal}`),
                text: "TOOL",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
          yield* start(1, initialThread);
          const first = yield* takeUntil(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeThreadRef !== null,
          );
          if (first.type !== "provider_thread.updated")
            return yield* Effect.die("Missing native thread receipt");
          assert.equal(first.providerThread.nativeThreadRef?.strength, "strong");
          yield* takeUntil(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          );
          const resumed = yield* runtime.resumeThread({
            providerThread: {
              ...first.providerThread,
              nativeThreadRef: {
                driver: runtime.driver,
                nativeId: "resumed-conversation",
                strength: "strong",
              },
            },
          });
          yield* start(2, resumed);
          const second = yield* takeUntil((event) => event.type === "turn.terminal");
          if (second.type === "turn.terminal") assert.equal(second.status, "completed");
          const args = (yield* fs.readFileString(argumentsPath)).trim().split("\n");
          assert.equal(args.filter((value) => value === "--effort").length, 2);
          assert.equal(args.filter((value) => value === "high").length, 2);
          assert.include(args, "resumed-conversation");
          const pids = (yield* fs.readFileString(pidPath)).trim().split("\n").map(Number);
          assert.equal(pids.length, 2);
          const replacementPid = pids[1];
          if (!replacementPid || !Number.isSafeInteger(replacementPid))
            return yield* Effect.die("Invalid fixture child PID");
          // The PID was recorded by this test's private wrapper before exec, never by a process search.
          yield* Effect.sync(() => process.kill(replacementPid, "SIGTERM"));
          yield* takeUntil(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          assert.equal(runtime.providerSession.status, "error");
        }),
      ),
  );
  it.effect("preserves exact user authorship on consecutive native prompts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("authorship");
        for (const ordinal of [1, 2]) {
          yield* h.start(ordinal, "ECHO_PROMPT");
          const terminal = yield* h.terminal();
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
          assert.equal(h.textFor(ordinal), "ECHO_PROMPT");
        }
      }),
    ),
  );

  it.effect("streams native tools and retains one conversation across repeated turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("streaming");
        yield* h.start(1, "TOOL one");
        yield* h.terminal();
        yield* h.start(2, "two");
        yield* h.terminal();
        assert.equal(h.textFor(2), "turn-2:two");
        const tools = h.recorded.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? [event.turnItem]
            : [],
        );
        assert.isTrue(tools.some((item) => item.status === "running"));
        assert.isTrue(tools.some((item) => item.status === "completed"));
        const ids = h.recorded.flatMap((event) =>
          event.type === "provider_thread.updated" && event.providerThread.nativeThreadRef
            ? [event.providerThread.nativeThreadRef.nativeId]
            : [],
        );
        assert.equal(new Set(ids).size, 1);
        assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 2);
        assert.equal((yield* h.fs.readFileString(h.pidPath)).trim().split("\n").length, 1);
      }),
    ),
  );

  it.effect("Stop settles a hung native turn once and a replacement resumes its conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("stop");
        yield* h.start(1, "HANG");
        const running = yield* h.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (running.type !== "provider_turn.updated")
          return yield* Effect.die("Missing accepted turn");
        yield* h.runtime.interruptTurn({
          providerThread: h.initialThread,
          providerTurnId: running.providerTurn.id,
        });
        const terminal = yield* h.terminal();
        assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
        assert.equal(terminal.type === "turn.terminal" && terminal.threadDisposition, "broken");
        yield* h.runtime.interruptTurn({
          providerThread: h.initialThread,
          providerTurnId: running.providerTurn.id,
        });
        assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 1);
        const replacement = yield* h.adapter.openSession({
          threadId: h.threadId,
          providerSessionId: ProviderSessionId.make("agy-stop-replacement"),
          modelSelection: h.modelSelection,
          runtimePolicy: {
            cwd: h.config.stateDir,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          initialNativeThreadId: "stop-resumed-conversation",
        });
        const thread = yield* replacement.ensureThread({
          threadId: h.threadId,
          modelSelection: h.modelSelection,
          runtimePolicy: {
            cwd: h.config.stateDir,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        });
        assert.equal(thread.nativeThreadRef?.nativeId, "stop-resumed-conversation");
        const replacementEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* replacement.events.pipe(
          Stream.runForEach((event) => Queue.offer(replacementEvents, event)),
          Effect.forkScoped,
        );
        yield* replacement.startTurn({ ...h.turnInput(2, "after cancel"), providerThread: thread });
        while (true) {
          const event = yield* Queue.take(replacementEvents);
          if (event.type !== "turn.terminal") continue;
          assert.equal(event.status, "completed");
          break;
        }
        assert.isFalse(
          h.recorded.some((event) => event.type === "turn.terminal" && event.status === "failed"),
        );
      }),
    ),
  );

  it.effect("stages native attachments privately and removes only its own copies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("attachments");
        const id = "thread-123e4567-e89b-12d3-a456-426614174000";
        yield* h.fs.makeDirectory(h.config.attachmentsDir, { recursive: true });
        const source = h.path.join(h.config.attachmentsDir, `${id}.png`);
        yield* h.fs.writeFileString(source, "image-bytes");
        yield* h.start(1, "Inspect the attachment.", [
          { type: "image", id, name: "result.png", mimeType: "image/png", sizeBytes: 11 },
        ]);
        yield* h.terminal();
        const staged = h.textFor(1)?.match(/available at: ([^\]]+)\]/u)?.[1];
        assert.isDefined(staged);
        if (!staged) return yield* Effect.die("Missing staged path");
        assert.include(staged, "scient-antigravity-attachments-");
        assert.notEqual(staged, source);
        assert.equal(yield* h.fs.readFileString(staged), "image-bytes");
        assert.equal((yield* h.fs.stat(staged)).mode & 0o777, 0o600);
        yield* h.adapter.stopAll();
        assert.isFalse(yield* h.fs.exists(staged));
        assert.equal(yield* h.fs.readFileString(source), "image-bytes");
      }),
    ),
  );

  it.effect(
    "isolates concurrent native sessions through repeated turns and closes all owned peers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* setupNative("isolation-0");
          const ids = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => i),
            (index) =>
              Effect.gen(function* () {
                const h =
                  index === 0 ? first : yield* setupNative(`isolation-${index}`, first.adapter);
                for (let ordinal = 1; ordinal <= 25; ordinal++) {
                  yield* h.start(ordinal, `session-${index}-${ordinal}`);
                  yield* h.terminal();
                  assert.equal(h.textFor(ordinal), `turn-${ordinal}:session-${index}-${ordinal}`);
                }
                assert.equal(
                  h.recorded.filter((event) => event.type === "turn.terminal").length,
                  25,
                );
                return h.recorded
                  .flatMap((event) =>
                    event.type === "provider_thread.updated" && event.providerThread.nativeThreadRef
                      ? [event.providerThread.nativeThreadRef.nativeId]
                      : [],
                  )
                  .at(-1);
              }),
            { concurrency: "unbounded" },
          );
          assert.equal(new Set(ids).size, 8);
          yield* first.adapter.stopAll();
          const pids = (yield* first.fs.readFileString(first.pidPath))
            .trim()
            .split("\n")
            .map(Number);
          assert.equal(pids.length, 8);
          for (const pid of pids) assert.throws(() => process.kill(pid, 0));
        }),
      ),
  );

  it.effect("reports a native failed result truthfully and reuses the same peer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("failure");
        yield* h.start(1, "FAIL");
        const failure = yield* h.terminal();
        assert.equal(failure.type === "turn.terminal" && failure.status, "failed");
        if (failure.type === "turn.terminal" && failure.status === "failed") {
          assert.include(failure.failure.message, "mock turn failure");
          assert.equal(failure.threadDisposition, "reusable");
        }
        yield* h.start(2, "recovered");
        const recovered = yield* h.terminal();
        assert.equal(recovered.type === "turn.terminal" && recovered.status, "completed");
        assert.equal(h.textFor(2), "turn-2:recovered");
        assert.equal((yield* h.fs.readFileString(h.pidPath)).trim().split("\n").length, 1);
      }),
    ),
  );

  it.effect("rejects fabricated interactive responses and unsupported native rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupNative("unsupported");
        const capabilities = yield* h.adapter.getCapabilities();
        assert.isFalse(capabilities.threads.canRollbackThread);
        assert.isFalse(capabilities.approvals.supportsCommandApproval);
        assert.isFalse(capabilities.planning.supportsStructuredQuestions);
        const response = yield* Effect.flip(
          h.runtime.respondToRuntimeRequest({
            requestId: RuntimeRequestId.make("fabricated"),
            decision: "accept",
          }),
        );
        assert.equal(response._tag, "ProviderAdapterRuntimeRequestResponseError");
        const rollback = yield* Effect.flip(
          h.runtime.rollbackThread({
            providerThread: h.initialThread,
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("fake"),
              appRunOrdinal: 0,
            },
            providerThreadTurns: [],
          }),
        );
        assert.equal(rollback._tag, "ProviderAdapterRollbackThreadError");
      }),
    ),
  );
});
