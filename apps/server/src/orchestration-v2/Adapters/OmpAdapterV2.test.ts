import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OmpSettings,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProjectId,
  RunId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";
import * as ServerConfig from "../../config.ts";
import { makeOmpRedaction, type OmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeOmpAdapterV2 } from "./OmpAdapterV2.ts";
import { ompTarget, type OmpTarget } from "../../provider/omp/OmpTarget.ts";
import {
  scientAgentTarget,
  scientAgentProcessEnvironment,
} from "../../provider/scient/ScientAgentTarget.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";
const decodeOmpSettings = Schema.decodeEffect(OmpSettings);

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcessPlatform, "darwin"),
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-v2-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const success = (command: string): OmpRpcResponse => ({
  id: command,
  type: "response",
  command,
  success: true,
  data: {},
});
const harness = Effect.fnUntraced(function* (
  ignoreModelWrite = false,
  behavior?: {
    readonly initialNativeThreadId?: string;
    readonly ignoreFreshWrite?: boolean;
    readonly misreportResume?: boolean;
    readonly target?: OmpTarget;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const notifications = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
  const promptDelivered = yield* Deferred.make<void>();
  let freshSessions = 0;
  let switches = 0;
  let prompts = 0;
  let eventFilterWrites = 0;
  let processTarget: OmpTarget | undefined;
  let processStateRoot: string | undefined;
  let processSessionDir: string | undefined;
  const target = behavior?.target ?? ompTarget;
  const scientific = target.driverKind === scientAgentTarget.driverKind;
  const ownedHome = path.join(config.stateDir, "scient-agent", "instances", "scient-v2-test");
  const environment = scientific
    ? scientAgentProcessEnvironment({
        root: ownedHome,
        platform: yield* HostProcessPlatform,
        baseEnv: { OMP_PROFILE: "foreign-omp-profile", PI_CODING_AGENT_DIR: "/foreign/omp-home" },
      })
    : {};
  let model = { provider: "test", id: "initial" };
  const instanceId = ProviderInstanceId.make(scientific ? "scient-v2-test" : "omp-v2-test");
  const threadId = ThreadId.make(`omp-v2-${yield* (yield* Crypto.Crypto).randomUUIDv4}`);
  const modelSelection = { instanceId, model: "test/selected" };
  const runtimePolicy = {
    cwd: config.stateDir,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
  const adapter = makeOmpAdapterV2({
    target,
    instanceId,
    settings: yield* decodeOmpSettings({ binaryPath: scientific ? "scient-agent" : "omp" }),
    ...(scientific ? { homePath: ownedHome } : {}),
    environment,
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    fileSystem: fs,
    path,
    crypto: yield* Crypto.Crypto,
    serverConfig: config,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    continuations: { offer: () => Effect.void },
    makeProcess: (options) =>
      Effect.gen(function* () {
        processTarget = options.target;
        processStateRoot = options.env?.SCIENT_AGENT_ROOT;
        processSessionDir = options.sessionDir;
        const sessionDir = options.sessionDir;
        if (!sessionDir) return yield* Effect.die("Missing owned session directory");
        let sessionFile = path.join(sessionDir, "session.jsonl");
        let sessionId = "session";
        const sessions = new Map([[sessionFile, sessionId]]);
        yield* fs.writeFileString(sessionFile, "{}\n").pipe(Effect.orDie);

        const client: OmpRpcProcess = {
          version: scientific ? "0.1.0" : "18.3.1",
          runtimeVersion: scientific ? "18.4.8" : "18.3.1",
          redaction: makeOmpRedaction({}, []),
          shutdown: Effect.succeed({ code: 0, forced: false, stderrTail: "" }),
          ready: Effect.succeed({
            type: "ready",
            protocolVersion: 2,
            supportedProtocolVersions: [2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
          events: Stream.fromQueue(notifications),
          flushEvents: () => Queue.offer(notifications, { _tag: "Drain" }).pipe(Effect.asVoid),
          command: (body) =>
            Effect.gen(function* () {
              if (body.type === "new_session" && !behavior?.ignoreFreshWrite) {
                freshSessions += 1;
                sessionId = `fresh-${freshSessions}`;
                sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
                sessions.set(sessionFile, sessionId);
                yield* fs.writeFileString(sessionFile, "{}\n").pipe(Effect.orDie);
              }
              return success(body.type);
            }),
          prompt: () =>
            Effect.gen(function* () {
              prompts += 1;
              yield* Deferred.succeed(promptDelivered, undefined);
              return success("prompt");
            }),
          steer: () => Effect.succeed(success("steer")),
          followUp: () => Effect.succeed(success("follow_up")),
          abort: () => Effect.succeed(success("abort")),
          getState: () =>
            Effect.sync(() => ({
              sessionFile,
              sessionId,
              model,
              isStreaming: false,
              isCompacting: false,
            })),
          getModels: () => Effect.succeed({ models: [] }),
          getCommands: () => Effect.succeed({ commands: [] }),
          setModel: (provider, id) =>
            Effect.sync(() => {
              if (!ignoreModelWrite) model = { provider, id };
              return success("set_model");
            }),
          setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
          compact: () => Effect.succeed(success("compact")),
          switchSession: (requested) =>
            Effect.sync(() => {
              switches += 1;
              if (!behavior?.misreportResume) {
                sessionFile = requested;
                sessionId = sessions.get(requested) ?? "unrecognized";
              }
              return { cancelled: false };
            }),
          setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
          setEventFilter: (filter) =>
            Effect.sync(() => {
              eventFilterWrites += 1;
              return { events: filter === null ? null : [...filter] };
            }),
          limits: Effect.succeed({
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
          setHostTools: () => Effect.succeed(success("set_host_tools")),
          setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
          extensionUiResponse: () => Effect.void,
          hostToolUpdate: () => Effect.void,
          hostToolResult: () => Effect.void,
          hostUriResult: () => Effect.void,
          close: () => Effect.void,
        };
        return client;
      }),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("omp-v2-session"),
    modelSelection,
    runtimePolicy,
    ...(behavior?.initialNativeThreadId === undefined
      ? {}
      : { initialNativeThreadId: behavior.initialNativeThreadId }),
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("omp-v2-project"),
    title: "OMP parity",
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
  const input = {
    appThread,
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make("omp-v2-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("omp-v2-attempt"),
    rootNodeId: NodeId.make("omp-v2-root"),
    message: {
      messageId: MessageId.make("omp-v2-message"),
      text: "Hello",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
  };
  const projected = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const recorded: ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(projected, event)),
    Effect.forkScoped,
  );
  const takeUntil = Effect.fnUntraced(function* (
    predicate: (event: ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(projected);
      recorded.push(event);
      if (predicate(event)) return event;
    }
  });
  return {
    runtime,
    input,
    ownedHome,
    processTarget,
    processStateRoot,
    processSessionDir,
    eventFilterWrites: () => eventFilterWrites,
    prompts: () => prompts,
    freshSessions: () => freshSessions,
    switches: () => switches,
    promptDelivered,
    notifications,
    recorded,
    takeUntil,
  };
});

it.layer(TestLayer)("OmpAdapterV2", (it) => {
  it.effect("runs Scient Agent through its independent native target and runtime version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, { target: scientAgentTarget });
        assert.equal(h.runtime.driver, scientAgentTarget.driverKind);
        assert.strictEqual(h.processTarget, scientAgentTarget);
        assert.equal(h.processStateRoot, h.ownedHome);
        assert.include(h.processSessionDir ?? "", "scient-agent-sessions");
        assert.notInclude(h.processSessionDir ?? "", "/omp-sessions/");
        // Product 0.1.0 speaks OMP 18.4.8; feature gates use the runtime release.
        assert.equal(h.eventFilterWrites(), 1);
        const cursor = h.input.providerThread.nativeMetadata?.resumeCursor;
        assert.deepInclude(cursor, { driverKind: "scient", ompVersion: "18.4.8" });
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.promptDelivered);
        assert.equal(h.prompts(), 1);
      }),
    ),
  );

  it.effect("names Scient Agent when its native reasoning selection is coerced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, { target: scientAgentTarget });
        yield* h.runtime.startTurn({
          ...h.input,
          modelSelection: {
            ...h.input.modelSelection,
            options: [{ id: "thinkingLevel", value: "off" }],
          },
        });
        const warning = yield* h.takeUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "Scient Agent reasoning selection",
        );
        if (warning.type !== "turn_item.updated" || warning.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Missing native reasoning warning");
        assert.equal(
          warning.turnItem.output,
          "Scient Agent applied its default reasoning instead of off.",
        );
        yield* Deferred.await(h.promptDelivered);
        assert.equal(h.prompts(), 1);
      }),
    ),
  );

  it.effect("resumes an exact Scient cursor but refuses OMP authority in the same instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, { target: scientAgentTarget });
        const providerThread = h.input.providerThread;
        const cursor = providerThread.nativeMetadata?.resumeCursor;
        if (typeof cursor !== "object" || cursor === null)
          return yield* Effect.die("Missing Scient continuation cursor");
        const resumed = yield* h.runtime.resumeThread({ providerThread });
        assert.equal(resumed.id, providerThread.id);
        assert.equal(h.switches(), 1);
        const rejected = yield* Effect.result(
          h.runtime.resumeThread({
            providerThread: {
              ...providerThread,
              nativeMetadata: { resumeCursor: { ...cursor, driverKind: "omp" } },
            },
          }),
        );
        assert.equal(rejected._tag, "Failure");
        assert.equal(h.switches(), 1);
      }),
    ),
  );

  it.effect("opens fresh native state without trusting an eager native id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, { initialNativeThreadId: "/foreign/unvalidated.jsonl" });
        assert.equal(h.switches(), 0);
        assert.equal(h.freshSessions(), 1);
        assert.isDefined(h.input.providerThread.nativeMetadata?.resumeCursor);
        assert.isTrue(
          h.input.providerThread.nativeThreadRef?.nativeId?.endsWith("fresh-1.jsonl") === true,
        );
      }),
    ),
  );

  it.effect("refuses acknowledged new-session commands that retain the previous transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* Effect.result(harness(false, { ignoreFreshWrite: true }));
        assert.equal(result._tag, "Failure");
      }),
    ),
  );

  it.effect("resumes its exact durable cursor and preserves it on the existing provider row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const stored = h.input.providerThread.nativeMetadata?.resumeCursor;
        if (typeof stored !== "object" || stored === null)
          return yield* Effect.die("Missing durable cursor");
        const oldFile = h.input.providerThread.nativeThreadRef?.nativeId?.replace(
          /fresh-1\.jsonl$/,
          "session.jsonl",
        );
        if (!oldFile) return yield* Effect.die("Missing native transcript");
        const prior = {
          ...h.input.providerThread,
          nativeThreadRef: {
            ...h.input.providerThread.nativeThreadRef,
            driver: h.runtime.driver,
            nativeId: oldFile,
            strength: "strong" as const,
          },
          nativeMetadata: {
            resumeCursor: { ...stored, relativeSessionFile: "session.jsonl", sessionId: "session" },
          },
        };
        const resumed = yield* h.runtime.resumeThread({ providerThread: prior });
        assert.equal(h.switches(), 1);
        assert.equal(resumed.id, prior.id);
        assert.equal(resumed.nativeThreadRef?.nativeId, oldFile);
        assert.deepEqual(resumed.nativeMetadata?.resumeCursor, prior.nativeMetadata.resumeCursor);
      }),
    ),
  );

  it.effect("recreates fresh native state when a switch reports another transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, { misreportResume: true });
        const stored = h.input.providerThread.nativeMetadata?.resumeCursor;
        if (typeof stored !== "object" || stored === null)
          return yield* Effect.die("Missing durable cursor");
        const oldFile = h.input.providerThread.nativeThreadRef?.nativeId?.replace(
          /fresh-1\.jsonl$/,
          "session.jsonl",
        );
        if (!oldFile) return yield* Effect.die("Missing native transcript");
        const prior = {
          ...h.input.providerThread,
          nativeThreadRef: {
            driver: h.runtime.driver,
            nativeId: oldFile,
            strength: "strong" as const,
          },
          nativeMetadata: {
            resumeCursor: { ...stored, relativeSessionFile: "session.jsonl", sessionId: "session" },
          },
        };
        assert.equal(
          (yield* Effect.result(h.runtime.resumeThread({ providerThread: prior })))._tag,
          "Failure",
        );
        assert.equal(h.switches(), 1);
        const fresh = yield* h.runtime.ensureThread({
          threadId: h.input.threadId,
          modelSelection: h.input.modelSelection,
          runtimePolicy: h.input.runtimePolicy,
          existingProviderThread: { ...prior, nativeThreadRef: null },
        });
        assert.equal(h.freshSessions(), 2);
        assert.equal(fresh.id, prior.id);
        assert.notEqual(fresh.nativeThreadRef?.nativeId, oldFile);
        assert.notEqual(
          fresh.nativeThreadRef?.nativeId,
          h.input.providerThread.nativeThreadRef?.nativeId,
        );
      }),
    ),
  );

  for (const failure of [
    "missing",
    "malformed",
    "workspace",
    "home-profile",
    "file",
    "session",
    "major",
  ] as const) {
    it.effect(
      `rejects a ${failure} native cursor before switch and binds portable fallback to fresh state`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness();
            const stored = h.input.providerThread.nativeMetadata?.resumeCursor;
            if (typeof stored !== "object" || stored === null)
              return yield* Effect.die("Missing durable cursor");
            const replacement =
              failure === "missing"
                ? undefined
                : failure === "malformed"
                  ? {}
                  : {
                      ...stored,
                      ...(failure === "workspace"
                        ? { workspaceFingerprint: "different-workspace" }
                        : {}),
                      ...(failure === "home-profile"
                        ? { homeProfileFingerprint: "different-profile" }
                        : {}),
                      ...(failure === "file" ? { relativeSessionFile: "../escaped.jsonl" } : {}),
                      ...(failure === "session" ? { sessionId: "different-session" } : {}),
                      ...(failure === "major" ? { ompVersion: "19.0.0" } : {}),
                    };
            const prior = {
              ...h.input.providerThread,
              nativeMetadata: { resumeCursor: replacement },
            };
            const rejected = yield* Effect.result(
              h.runtime.resumeThread({ providerThread: prior }),
            );
            assert.equal(rejected._tag, "Failure");
            assert.equal(h.switches(), failure === "session" ? 1 : 0);
            const fallback = yield* h.runtime.ensureThread({
              threadId: h.input.threadId,
              modelSelection: h.input.modelSelection,
              runtimePolicy: h.input.runtimePolicy,
              existingProviderThread: { ...prior, nativeThreadRef: null },
            });
            assert.equal(fallback.id, prior.id);
            assert.isDefined(fallback.nativeMetadata?.resumeCursor);
            assert.isDefined(fallback.nativeThreadRef);
            if (failure === "session")
              assert.notEqual(fallback.nativeThreadRef?.nativeId, prior.nativeThreadRef?.nativeId);
            yield* h.runtime.startTurn({
              ...h.input,
              providerThread: fallback,
              message: { ...h.input.message, text: "Portable history followed by current request" },
            });
            yield* Deferred.await(h.promptDelivered);
            assert.equal(h.prompts(), 1);
          }),
        ),
    );
  }

  it.effect("projects native tool input and output under the delivering run and instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(h.input);
        yield* Queue.offer(h.notifications, {
          _tag: "Event",
          event: {
            type: "tool_execution_start",
            toolCallId: "read-one",
            toolName: "read",
            args: { path: "result.txt" },
          },
        });
        yield* Queue.offer(h.notifications, {
          _tag: "Event",
          event: {
            type: "tool_execution_end",
            toolCallId: "read-one",
            toolName: "read",
            result: { text: "Measured result" },
          },
        });
        const completed = yield* h.takeUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        );
        if (completed.type !== "turn_item.updated" || completed.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Missing tool completion");
        assert.equal(completed.turnItem.runId, h.input.runId);
        assert.equal(completed.turnItem.providerThreadId, h.input.providerThread.id);
        assert.equal(completed.turnItem.toolName, "read");
        assert.deepEqual(completed.turnItem.input, { path: "result.txt" });
        assert.equal(completed.turnItem.output, "Measured result");
      }),
    ),
  );

  it.effect(
    "projects native subagent lineage and readable results with the spawning run owner",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.runtime.startTurn(h.input);
          yield* Queue.offer(h.notifications, {
            _tag: "Event",
            event: {
              type: "subagent_lifecycle",
              payload: { id: "review-child", status: "started", description: "Inspect result" },
            },
          });
          const started = yield* h.takeUntil(
            (event) => event.type === "subagent.updated" && event.subagent.status === "running",
          );
          if (started.type !== "subagent.updated")
            return yield* Effect.die("Missing subagent start");
          yield* Queue.offer(h.notifications, {
            _tag: "Event",
            event: {
              type: "subagent_lifecycle",
              payload: {
                id: "review-child",
                status: "completed",
                message: "The measured result is consistent.",
              },
            },
          });
          const finished = yield* h.takeUntil(
            (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
          );
          if (finished.type !== "subagent.updated")
            return yield* Effect.die("Missing subagent completion");
          assert.equal(finished.subagent.id, started.subagent.id);
          assert.equal(finished.subagent.runId, h.input.runId);
          assert.equal(finished.subagent.parentNodeId, h.input.rootNodeId);
          const child = h.recorded.find((event) => event.type === "app_thread.created");
          if (child?.type !== "app_thread.created")
            return yield* Effect.die("Missing observed child thread");
          assert.equal(child.appThread.lineage.parentThreadId, h.input.threadId);
          assert.equal(child.appThread.providerInstanceId, h.input.modelSelection.instanceId);
          assert.equal(finished.subagent.childThreadId, child.appThread.id);
          assert.isTrue(
            h.recorded.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.threadId === child.appThread.id &&
                event.message.text === "The measured result is consistent.",
            ),
          );
        }),
      ),
  );

  it.effect("refuses an acknowledged model write that did not change native state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(true);
        assert.equal((yield* Effect.result(h.runtime.startTurn(h.input)))._tag, "Failure");
        assert.equal(h.prompts(), 0);
      }),
    ),
  );
  it.effect("projects the confirmed native model before delivering a prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(h.input);
        assert.equal(h.runtime.providerSession.model, "test/selected");
      }),
    ),
  );
  it.effect("rejects unsupported supervision on an already opened full-access session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        assert.equal(
          (yield* Effect.result(
            h.runtime.startTurn({
              ...h.input,
              runtimePolicy: { ...h.input.runtimePolicy, runtimeMode: "approval-required" },
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(h.prompts(), 0);
      }),
    ),
  );
});
