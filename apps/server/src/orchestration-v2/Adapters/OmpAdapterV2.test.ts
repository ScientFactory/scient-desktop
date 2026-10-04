// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OmpSettings,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
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
import { OMP_PENDING_CONNECTION_DETAIL } from "../../provider/omp/OmpModel.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import { OMP_KNOWN_EVENT_TYPES, type OmpRpcResponse } from "effect-omp-rpc/schema";
import * as ServerConfig from "../../config.ts";
import { makeOmpRedaction, type OmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeOmpAdapterV2 } from "./OmpAdapterV2.ts";
import { makeOmpRpcClient } from "effect-omp-rpc/client";
import {
  makeOmpCaptureReplay,
  type OmpCaptureName,
  type OmpCaptureReplay,
} from "../../provider/omp/OmpCaptureReplay.testFixtures.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { ompTarget, type OmpTarget } from "../../provider/omp/OmpTarget.ts";
import {
  scientAgentTarget,
  scientAgentProcessEnvironment,
} from "../../provider/scient/ScientAgentTarget.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Error } from "../ProviderAdapter.ts";
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
    readonly model?: string;
    readonly initialNativeThreadId?: string;
    readonly ignoreFreshWrite?: boolean;
    readonly misreportResume?: boolean;
    readonly target?: OmpTarget;
    readonly makeProcess?: Parameters<typeof makeOmpAdapterV2>[0]["makeProcess"];
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
  const modelSelection = { instanceId, model: behavior?.model ?? "test/selected" };
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
    makeProcess:
      behavior?.makeProcess ??
      ((options) =>
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
        })),
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
      const event = yield* Queue.take(projected).pipe(
        Effect.timeout("3 seconds"),
        TestClock.withLive,
      );
      recorded.push(event);
      if (predicate(event)) return event;
    }
  });
  return {
    runtime,
    input,
    fs,
    path,
    config,
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
    projected,
    takeUntil,
  };
});

const imageHarness = Effect.fnUntraced(function* (
  maxFrameBytes = 1_048_576,
  configuration: Partial<Parameters<typeof scriptedOmpRpc>[0]> = {},
) {
  const peer = scriptedOmpRpc({
    models: [{ provider: "test", id: "selected", input: ["text", "image"], contextWindow: null }],
    initial: { provider: "test", id: "selected" },
    maxFrameBytes,
    ...configuration,
  });
  const h = yield* harness(false, { makeProcess: peer.makeProcess });
  yield* h.fs.makeDirectory(h.config.attachmentsDir, { recursive: true });
  const image = Effect.fnUntraced(function* (id: string, size: number) {
    const stored = h.path.join(h.config.attachmentsDir, `${id}.png`);
    yield* h.fs.writeFile(stored, new Uint8Array(size).fill(7));
    return {
      type: "image" as const,
      id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: size,
    };
  });
  const send = Effect.fnUntraced(function* (
    ordinal: number,
    text: string,
    attachments: ReadonlyArray<Effect.Success<ReturnType<typeof image>>>,
  ) {
    yield* h.runtime.startTurn({
      ...h.input,
      runId: RunId.make(`image-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`image-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`image-root-${ordinal}`),
      message: {
        ...h.input.message,
        messageId: MessageId.make(`image-message-${ordinal}`),
        text,
        attachments,
      },
    });
    yield* peer.finish();
    const terminal = yield* h.takeUntil((event) => event.type === "turn.terminal");
    if (terminal.type !== "turn.terminal") return yield* Effect.die("Missing image terminal");
    assert.equal(terminal.status, "completed");
    return peer.state.prompts.at(-1)!;
  });
  return { ...h, peer, image, send };
});
const reasoningModel = (
  provider: string,
  id: string,
  levels: ReadonlyArray<string> = ["low", "high"],
  defaultLevel = "low",
) => ({
  provider,
  id,
  reasoning: true,
  input: ["text"],
  thinking: { mode: "effort", efforts: levels, defaultLevel },
});
const modelHarness = Effect.fnUntraced(function* (
  configuration: Partial<Parameters<typeof scriptedOmpRpc>[0]> = {},
) {
  const peer = scriptedOmpRpc({
    models: [reasoningModel("vendor", "a"), reasoningModel("vendor", "b")],
    initial: { provider: "vendor", id: "a", level: "high" },
    ...configuration,
  });
  const h = yield* harness(false, { model: "vendor/a", makeProcess: peer.makeProcess });
  peer.state.log.length = 0;
  const start = (ordinal: number, model: string, level?: string, text = "Select honestly") =>
    h.runtime.startTurn({
      ...h.input,
      runId: RunId.make(`model-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`model-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`model-root-${ordinal}`),
      modelSelection: {
        instanceId: h.input.modelSelection.instanceId,
        model,
        ...(level === undefined ? {} : { options: [{ id: "thinkingLevel", value: level }] }),
      },
      message: { ...h.input.message, text },
    });
  const terminal = () => h.takeUntil((event) => event.type === "turn.terminal");
  const mutations = () => peer.state.log.filter((entry) => entry.startsWith("set_"));
  return { ...h, peer, start, terminal, mutations };
});

const ordinaryToolsHarness = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string>> = {},
) {
  const h = yield* imageHarness(1_048_576, { environment });
  yield* h.runtime.startTurn(h.input);
  yield* h.peer.promptDelivered();
  yield* h.peer.emit([{ type: "agent_start" }]);
  const latestTools = () => [
    ...new Map(
      h.recorded.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [[event.turnItem.id, event.turnItem] as const]
          : [],
      ),
    ).values(),
  ];
  const tool = (id: string) =>
    latestTools().find((item) => item.nativeItemRef?.nativeId?.endsWith(`:${id}`));
  const untilTool = (id: string, status?: string) =>
    h.takeUntil(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.nativeItemRef?.nativeId?.endsWith(`:${id}`) === true &&
        (status === undefined || event.turnItem.status === status),
    );
  const stop = Effect.gen(function* () {
    const turn = h.recorded.find((event) => event.type === "provider_turn.updated");
    if (!turn || turn.type !== "provider_turn.updated")
      return yield* Effect.die("Missing tool turn");
    yield* h.runtime.interruptTurn({
      providerThread: h.input.providerThread,
      providerTurnId: turn.providerTurn.id,
    });
    return yield* h.takeUntil((event) => event.type === "turn.terminal");
  });
  return { ...h, tool, latestTools, untilTool, stop: () => stop };
});
const nativeToolStart = (id: string, name: string, args: unknown) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args,
});
const nativeToolEnd = (id: string, name: string, result: unknown, isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result,
  isError,
});

const encodeDiagnostic = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeImagePath = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const attachedImagePaths = (message: string | undefined) =>
  (message ?? "")
    .split("\n")
    .filter((line) => line.startsWith('"') && line.includes("attachments"))
    .map((value) => decodeImagePath(value));

const capturedTurn = Effect.fnUntraced(function* (name: OmpCaptureName, interrupt = false) {
  const path = yield* Path.Path;
  let replay: OmpCaptureReplay | undefined;
  const h = yield* harness(false, {
    model: "scient-stub/stub-model",
    makeProcess: (options) =>
      Effect.gen(function* () {
        if (!options.sessionDir)
          return yield* Effect.die("Missing native capture session directory");
        let ordinal = 0;
        replay = yield* makeOmpCaptureReplay(name, (command) => {
          if (command.type === "new_session") ordinal++;
          if (command.type !== "get_state") return undefined;
          const sessionFile = path.join(options.sessionDir!, `capture-session-${ordinal}.jsonl`);
          NodeFS.writeFileSync(sessionFile, "{}\n");
          return {
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: {
              sessionId: `capture-session-${ordinal}`,
              sessionFile,
              model: { provider: "scient-stub", id: "stub-model" },
              thinkingLevel: "off",
              isStreaming: false,
              hasPendingAsyncWork: false,
              isSettled: true,
            },
          };
        });
        const client = yield* makeOmpRpcClient(replay.io);
        return {
          ...client,
          version: "18.3.1",
          runtimeVersion: "18.3.1",
          redaction: makeOmpRedaction({}, []),
          shutdown: replay.io.close!.pipe(Effect.as({ code: 0, forced: false, stderrTail: "" })),
        };
      }),
  });
  if (!replay) return yield* Effect.die("Missing actual capture transport");
  yield* h.runtime.startTurn({ ...h.input, message: { ...h.input.message, text: "Say hello." } });
  let interrupting: Fiber.Fiber<void, ProviderAdapterV2Error> | undefined;
  while (true) {
    const event = yield* h.takeUntil(() => true);
    if (
      interrupt &&
      !interrupting &&
      event.type === "message.updated" &&
      event.message.text.length > 0
    ) {
      const turn = h.recorded.find((event) => event.type === "provider_turn.updated");
      if (turn?.type !== "provider_turn.updated")
        return yield* Effect.die("Missing native capture turn");
      interrupting = yield* h.runtime
        .interruptTurn({
          providerThread: h.input.providerThread,
          providerTurnId: turn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
    }
    if (event.type === "turn.terminal") break;
  }
  if (interrupting) yield* Fiber.join(interrupting);
  yield* replay.releaseLateFrames;
  yield* Effect.sleep("50 millis").pipe(TestClock.withLive);
  const late = yield* Queue.clear(h.projected);
  const latestItems = [
    ...new Map(
      h.recorded.flatMap((event) =>
        event.type === "turn_item.updated" ? [[event.turnItem.id, event.turnItem] as const] : [],
      ),
    ).values(),
  ];
  return {
    ...h,
    replay,
    late,
    latestItems,
    terminal: h.recorded.filter((event) => event.type === "turn.terminal"),
    assistant: latestItems.filter((item) => item.type === "assistant_message"),
    warnings: latestItems.flatMap((item) =>
      item.type === "dynamic_tool" && item.toolName === "Oh My Pi warning" ? [item] : [],
    ),
  };
});

it.layer(TestLayer)("OmpAdapterV2", (it) => {
  it.effect(
    "delivers native OMP images inline or through read according to actual RPC frame bytes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* imageHarness();
          const small = yield* h.send(1, "small", [yield* h.image("small", 600 * 1024)]);
          assert.lengthOf(small.frame.images ?? [], 1);
          assert.equal(small.frame.message, "small");
          assert.isAtMost(small.bytes, 1_048_576);
          assert.equal(Buffer.from(small.frame.images![0]!.data, "base64").length, 600 * 1024);
          for (const [ordinal, size] of [
            [2, 900 * 1024],
            [3, 3 * 1024 * 1024],
          ] as const) {
            const large = yield* h.send(ordinal, "large", [
              yield* h.image(`large-${ordinal}`, size),
            ]);
            assert.lengthOf(large.frame.images ?? [], 0);
            assert.include(large.frame.message ?? "", "read tool");
            const paths = attachedImagePaths(large.frame.message);
            assert.deepEqual(paths, [
              yield* h.fs.realPath(h.path.join(h.config.attachmentsDir, `large-${ordinal}.png`)),
            ]);
            assert.equal(Number((yield* h.fs.stat(paths[0]!)).size), size);
            assert.isAtMost(large.bytes, 1_048_576);
          }
          assert.lengthOf(
            h.recorded.filter((event) => event.type === "turn.terminal"),
            3,
          );
        }),
      ),
  );
  it.effect("budgets several native OMP images together against one serialized frame", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* imageHarness();
        const sent = yield* h.send(1, "two", [
          yield* h.image("first", 500 * 1024),
          yield* h.image("second", 500 * 1024),
        ]);
        assert.lengthOf(sent.frame.images ?? [], 1);
        assert.deepEqual(attachedImagePaths(sent.frame.message), [
          yield* h.fs.realPath(h.path.join(h.config.attachmentsDir, "second.png")),
        ]);
        assert.isAtMost(sent.bytes, 1_048_576);
      }),
    ),
  );
  it.effect("uses the native OMP peer's advertised physical frame limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* imageHarness(2 * 1024 * 1024);
        const sent = yield* h.send(1, "inline", [yield* h.image("wide", 900 * 1024)]);
        assert.lengthOf(sent.frame.images ?? [], 1);
        assert.equal(sent.frame.message, "inline");
        assert.lengthOf(attachedImagePaths(sent.frame.message), 0);
        assert.isAtMost(sent.bytes, 2 * 1024 * 1024);
        assert.isAbove(sent.bytes, 1_048_576);
      }),
    ),
  );
  it.effect(
    "refuses native OMP oversized attachments with an honest limit before prompt delivery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* imageHarness();
          const oversized = yield* h.image("oversize", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
          const failure = yield* Effect.result(
            h.runtime.startTurn({
              ...h.input,
              message: { ...h.input.message, attachments: [oversized] },
            }),
          );
          assert.equal(failure._tag, "Failure");
          if (failure._tag !== "Failure") return yield* Effect.die("Oversized image reached OMP");
          assert.include(Cause.pretty(Cause.fail(failure.failure)), "10 MB");
          assert.lengthOf(h.peer.state.prompts, 0);
        }),
      ),
  );

  it.effect("reports the native OMP frame limit when even a file reference cannot fit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* imageHarness(1024);
        const failure = yield* Effect.result(
          h.runtime.startTurn({
            ...h.input,
            message: {
              ...h.input.message,
              text: "Long request".repeat(1000),
              attachments: yield* Effect.forEach(
                Array.from({ length: 8 }, (_, i) => i),
                (i) => h.image(`frame-${i}`, 8192),
              ),
            },
          }),
        );
        assert.equal(failure._tag, "Failure");
        if (failure._tag !== "Failure") return yield* Effect.die("Oversized frame reached OMP");
        assert.include(Cause.pretty(Cause.fail(failure.failure)), "1024-byte frame limit");
        assert.lengthOf(h.peer.state.prompts, 0);
      }),
    ),
  );

  for (const failure of ["command", "decode"] as const) {
    it.effect(
      `keeps native OMP ${failure} model discovery failures out of text turns with safe diagnostics`,
      () => {
        const messages: unknown[] = [];
        const logger = Logger.make(({ message }) => messages.push(message));
        return Effect.scoped(
          Effect.gen(function* () {
            const h = yield* imageHarness(
              1_048_576,
              failure === "command"
                ? { modelsError: "Rejected Bearer synthetic-secret-123" }
                : {
                    modelsResponse: {
                      models: [
                        { provider: "test", id: "selected", input: { private: "catalog-secret" } },
                      ],
                    },
                  },
            );
            yield* h.send(1, "Text still works", []);
            assert.lengthOf(h.peer.state.prompts, 1);
            assert.isFalse(
              h.recorded.some(
                (event) =>
                  event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
              ),
            );
            const log = encodeDiagnostic(messages);
            assert.include(log, "Oh My Pi model discovery failed.");
            assert.include(log, "get_available_models");
            assert.include(
              log,
              failure === "command" ? "OmpRpcCommandError" : "OmpRpcProtocolError",
            );
            if (failure === "decode") assert.include(log, "models.0.input");
            assert.notInclude(log, "synthetic-secret-123");
            assert.notInclude(log, "catalog-secret");
          }),
        ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      },
    );
  }
  it.effect(
    "retries native OMP image discovery and recovers on the same session without dispatching the rejection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* imageHarness(1_048_576, {
            modelsError: "Catalog temporarily unavailable",
          });
          const image = yield* h.image("catalog-recovery", 20);
          const failed = yield* Effect.result(
            h.runtime.startTurn({
              ...h.input,
              message: { ...h.input.message, attachments: [image] },
            }),
          );
          assert.equal(failed._tag, "Failure");
          if (failed._tag !== "Failure")
            return yield* Effect.die("Unverified image reached the peer");
          const detail = Cause.pretty(Cause.fail(failed.failure));
          assert.include(detail, "Couldn't verify image support");
          assert.notInclude(detail, "Catalog temporarily unavailable");
          assert.lengthOf(h.peer.state.prompts, 0);
          yield* h.takeUntil((event) => event.type === "turn.terminal");
          h.peer.state.modelsError = undefined;
          const sent = yield* h.send(2, "Describe", [image]);
          assert.lengthOf(sent.frame.images ?? [], 1);
          assert.lengthOf(h.peer.state.prompts, 1);
          assert.deepEqual(
            h.recorded.flatMap((event) => (event.type === "turn.terminal" ? [event.status] : [])),
            ["failed", "completed"],
          );
        }),
      ),
  );
  for (const input of [undefined, ["text"]] as const) {
    it.effect(
      `distinguishes native OMP ${input === undefined ? "unknown" : "unsupported"} image capability without poisoning text turns`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* imageHarness(1_048_576, {
              models: [
                { provider: "test", id: "selected", ...(input === undefined ? {} : { input }) },
              ],
              initial: { provider: "test", id: "initial" },
            });
            const failed = yield* Effect.result(
              h.runtime.startTurn({
                ...h.input,
                message: { ...h.input.message, attachments: [yield* h.image("capability", 20)] },
              }),
            );
            assert.equal(failed._tag, "Failure");
            if (failed._tag !== "Failure")
              return yield* Effect.die("Unsupported image reached the peer");
            assert.include(
              Cause.pretty(Cause.fail(failed.failure)),
              input === undefined ? "Couldn't verify image support" : "does not support images",
            );
            assert.lengthOf(h.peer.state.prompts, 0);
            assert.isFalse(h.peer.state.log.some((entry) => entry.startsWith("set_")));
            assert.deepEqual(h.peer.state.model, { provider: "test", id: "initial" });
            yield* h.takeUntil((event) => event.type === "turn.terminal");
            yield* h.send(2, "Text still works", []);
            assert.lengthOf(h.peer.state.prompts, 1);
          }),
        ),
    );
  }
  it.effect(
    "reports native OMP model capacity only for its own live instance and selected model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const h = yield* imageHarness(1_048_576, {
            models: [{ provider: "test", id: "a/b", contextWindow: 1_000_000 }],
          }).pipe(Effect.provideService(Scope.Scope, scope));
          assert.equal(
            h.runtime.getModelContextWindow?.({ ...h.input.modelSelection, model: "test/a%2Fb" }),
            1_000_000,
          );
          assert.isUndefined(
            h.runtime.getModelContextWindow?.({ ...h.input.modelSelection, model: "test/missing" }),
          );
          assert.isUndefined(
            h.runtime.getModelContextWindow?.({
              instanceId: ProviderInstanceId.make("foreign"),
              model: "test/a%2Fb",
            }),
          );
          yield* Scope.close(scope, Exit.void);
          assert.isUndefined(
            h.runtime.getModelContextWindow?.({ ...h.input.modelSelection, model: "test/a%2Fb" }),
          );
        }),
      ),
  );

  for (const scenario of [
    {
      name: "success-text",
      text: "Hello",
      statuses: ["completed"],
      warningCount: 0,
      status: "completed",
    },
    {
      name: "retry-recovered",
      text: "Recovered after retry",
      statuses: ["completed"],
      warningCount: 0,
      status: "completed",
    },
    {
      name: "success-reasoning",
      text: "Hello",
      statuses: ["completed"],
      warningCount: 0,
      status: "completed",
      reasoning: true,
    },
    {
      name: "auth-401",
      text: "",
      statuses: ["failed"],
      warningCount: 0,
      status: "failed",
      error: "401 Incorrect API key provided",
    },
    {
      name: "provider-model-not-found",
      text: "",
      statuses: ["failed"],
      warningCount: 0,
      status: "failed",
      error: "404 The model `stub-model` does not exist",
    },
    {
      name: "retry-recovered-session",
      text: "Recovered after session retry",
      statuses: ["failed", "completed"],
      warningCount: 1,
      status: "completed",
    },
    {
      name: "retry-exhausted",
      text: "",
      statuses: ["failed", "failed", "failed"],
      warningCount: 2,
      status: "failed",
      error:
        "429 Rate limit reached for requests. Please try again in 0.1s. retry-after-ms=100\nRate limit reached for requests. Please try again in 0.1s. (type=rate_limit_error param=rate_limit_exceeded)",
    },
    {
      name: "length-stop",
      text: "This answer is cut",
      statuses: ["completed"],
      warningCount: 0,
      status: "completed",
      stopReason: "length",
    },
    {
      name: "stream-error-after-partial",
      text: "Partial answer",
      statuses: ["failed"],
      warningCount: 0,
      status: "failed",
      error:
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    },
    {
      name: "stream-error-event",
      text: "Partial answer",
      statuses: ["failed"],
      warningCount: 0,
      status: "failed",
      error: "The server had an error while processing your request.",
    },
    {
      name: "tool-call",
      text: "The file says: stub fixture content.",
      statuses: ["completed", "completed"],
      warningCount: 0,
      status: "completed",
      tool: true,
    },
    {
      name: "user-abort",
      text: "tick0 ",
      statuses: ["interrupted"],
      warningCount: 0,
      status: "interrupted",
      interrupt: true,
    },
  ] as const) {
    it.effect(
      `projects the native OMP ${scenario.name} capture without duplicate or late outcomes`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* capturedTurn(scenario.name, "interrupt" in scenario);
            assert.deepEqual(
              h.terminal.map((event) => event.status),
              [scenario.status],
            );
            assert.equal(h.assistant.map((item) => item.text).join(""), scenario.text);
            assert.deepEqual(
              h.assistant.map((item) => item.status),
              [...scenario.statuses],
            );
            assert.isTrue(
              h.assistant.every((item) => item.title === null && item.streaming === false),
            );
            assert.lengthOf(h.warnings, scenario.warningCount);
            if (scenario.name === "retry-recovered-session")
              assert.include(h.warnings[0]?.output ?? "", "attempt 1 of 2");
            if ("reasoning" in scenario)
              assert.isTrue(
                h.latestItems.some((item) => item.type === "reasoning" && item.text.length > 0),
              );
            if ("error" in scenario) {
              const failure = h.terminal[0]?.failure;
              assert.include(failure?.message ?? "", scenario.error);
              if (scenario.name !== "auth-401" && scenario.name !== "provider-model-not-found")
                assert.equal(failure?.message, scenario.error);
              assert.equal(failure?.class, "provider_error");
              assert.equal(h.terminal[0]?.threadDisposition, "reusable");
              assert.equal(h.runtime.providerSession.lastError, failure?.message);
              assert.equal(h.runtime.providerSession.status, "ready");
            } else assert.isNull(h.terminal[0]?.failure);
            if ("stopReason" in scenario)
              assert.lengthOf(
                h.latestItems.filter(
                  (item) =>
                    item.type === "notification" &&
                    item.source.kind === "output_truncated" &&
                    item.source.stopReason === scenario.stopReason,
                ),
                1,
              );
            if ("tool" in scenario)
              assert.isTrue(
                h.latestItems.some(
                  (item) =>
                    item.type === "dynamic_tool" &&
                    item.toolName === "read" &&
                    item.status === "completed",
                ),
              );
            if (!("interrupt" in scenario)) assert.deepEqual(h.late, []);
            assert.isFalse(
              h.late.some(
                (event) =>
                  event.type !== "provider_session.updated" &&
                  event.type !== "provider_thread.updated",
              ),
            );
            if (scenario.status === "completed")
              assert.equal(h.runtime.providerSession.status, "ready");
          }),
        ),
    );
  }

  it.effect(
    "reads native OMP reasoning after a model default reset and preserves a clamped selection across steering and another turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness({
            models: [
              reasoningModel("vendor", "a"),
              reasoningModel("vendor", "b", ["low", "high", "xhigh"], "low"),
            ],
            clamp: { "vendor/b": { xhigh: "high" } },
          });
          yield* h.start(1, "vendor/b", "xhigh");
          yield* h.takeUntil(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              (typeof event.turnItem.output === "string" ? event.turnItem.output : "").includes(
                "instead of xhigh",
              ),
          );
          assert.equal(h.peer.state.thinkingLevel, "high");
          assert.deepEqual(h.mutations(), ["set_model vendor/b", "set_thinking_level xhigh"]);
          const turn = h.recorded.find((event) => event.type === "provider_turn.updated");
          if (!turn || turn.type !== "provider_turn.updated")
            return yield* Effect.die("Missing native model turn");
          yield* h.peer.promptDelivered();
          yield* h.runtime.steerTurn({
            runId: RunId.make("model-run-1"),
            threadId: h.input.threadId,
            providerThread: h.input.providerThread,
            providerTurnId: turn.providerTurn.id,
            message: { ...h.input.message, text: "Keep working" },
          });
          yield* h.peer.finish();
          yield* h.terminal();
          yield* h.start(2, "vendor/b", "xhigh");
          yield* h.peer.finish();
          yield* h.terminal();
          assert.deepEqual(h.mutations(), ["set_model vendor/b", "set_thinking_level xhigh"]);
          assert.deepEqual(
            h.peer.state.prompts.map((prompt) => prompt.frame.type),
            ["prompt", "steer", "prompt"],
          );
          assert.equal(h.runtime.providerSession.model, "vendor/b");
        }),
      ),
  );

  for (const invalid of ["max", "plain"] as const) {
    it.effect(
      `refuses native OMP ${invalid} reasoning before mutation and keeps the current session reusable`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* modelHarness({
              models: [
                reasoningModel("vendor", "a"),
                reasoningModel("vendor", "b", ["low", "medium", "high"]),
                { provider: "vendor", id: "plain", input: ["text"] },
              ],
            });
            const error = yield* h
              .start(
                1,
                invalid === "plain" ? "vendor/plain" : "vendor/b",
                invalid === "plain" ? "high" : "max",
              )
              .pipe(Effect.flip);
            const detail = encodeDiagnostic(error);
            assert.include(
              detail,
              invalid === "plain" ? "no reasoning levels" : "low, medium, high",
            );
            assert.deepEqual(h.mutations(), []);
            assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
            assert.equal(h.peer.state.thinkingLevel, "high");
            assert.equal(h.peer.state.prompts.length, 0);
            assert.equal(h.runtime.providerSession.status, "ready");
          }),
        ),
    );
  }

  for (const provider of ["scient_local", "ollama"] as const) {
    it.effect(
      `refreshes native OMP ${provider} registration before completing a late model selection`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* modelHarness({ lateModels: [reasoningModel(provider, "late")] });
            yield* h.start(1, `${provider}/late`, provider === "scient_local" ? "high" : undefined);
            yield* h.peer.finish();
            yield* h.terminal();
            assert.include(h.peer.state.log, "refresh");
            const writes = h.mutations();
            assert.deepEqual(
              writes,
              provider === "scient_local"
                ? ["set_model scient_local/late", "set_thinking_level high"]
                : ["set_model ollama/late", "set_model ollama/late"],
            );
            assert.deepEqual(h.peer.state.model, { provider, id: "late" });
            assert.equal(h.peer.state.prompts.length, 1);
          }),
        ),
    );
  }

  it.effect(
    "preserves the native OMP pending connection message without dispatch or selection mutation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness({
            setModelError: (provider) =>
              provider === "scient_new-keyed" ? OMP_PENDING_CONNECTION_DETAIL : undefined,
          });
          const error = yield* h.start(1, "scient_new-keyed/model").pipe(Effect.flip);
          assert.include(
            encodeDiagnostic(error),
            "Start a new conversation to use this connection",
          );
          assert.include(h.peer.state.log, "refresh");
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
          assert.equal(h.peer.state.prompts.length, 0);
        }),
      ),
  );

  it.effect(
    "validates refreshed native OMP levels without changing the previous model or dispatching",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness({
            lateModels: [reasoningModel("scient_local", "late", ["low", "medium"])],
          });
          const error = yield* h.start(1, "scient_local/late", "high").pipe(Effect.flip);
          assert.include(encodeDiagnostic(error), "low, medium");
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
          assert.equal(h.peer.state.thinkingLevel, "high");
          assert.equal(h.peer.state.prompts.length, 0);
          assert.deepEqual(h.mutations(), []);
        }),
      ),
  );

  for (const recoverable of [true, false] as const) {
    it.effect(
      `rechecks native OMP unknown reasoning before mutation with recovery=${recoverable}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let reportLevel = false;
            const h = yield* modelHarness({
              models: [
                reasoningModel("vendor", "a"),
                reasoningModel("vendor", "b", ["low", "high"], "high"),
              ],
              reportThinkingLevel: () => reportLevel,
              setThinkingLevelError: (level) =>
                level === "low" ? "Thinking level refused" : undefined,
            });
            reportLevel = recoverable;
            const error = yield* h.start(1, "vendor/b", "low").pipe(Effect.flip);
            assert.include(
              encodeDiagnostic(error),
              recoverable ? "Thinking level refused" : "current reasoning level",
            );
            assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
            assert.equal(h.peer.state.thinkingLevel, "high");
            assert.equal(h.peer.state.prompts.length, 0);
            assert.equal(h.runtime.providerSession.status, "ready");
            if (!recoverable) {
              assert.deepEqual(h.mutations(), []);
              yield* h.terminal();
              yield* h.start(2, "vendor/a");
              yield* h.peer.finish();
              yield* h.terminal();
              assert.equal(h.peer.state.prompts.length, 1);
            }
          }),
        ),
    );
  }

  it.effect(
    "retains native OMP's actual model when restoration is refused and reselects on the next turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let refuseRestore = true;
          const h = yield* modelHarness({
            initial: { provider: "vendor", id: "a", level: "low" },
            setThinkingLevelError: (level) =>
              level === "high" ? "Thinking level refused" : undefined,
            setModelError: (provider, id) => {
              if (provider !== "vendor" || id !== "a" || !refuseRestore) return undefined;
              refuseRestore = false;
              return "Model switch refused";
            },
          });
          const error = yield* h.start(1, "vendor/b", "high").pipe(Effect.flip);
          assert.include(encodeDiagnostic(error), "Thinking level refused");
          yield* h.terminal();
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "b" });
          assert.equal(h.runtime.providerSession.model, "vendor/b");
          assert.equal(h.runtime.providerSession.status, "ready");
          assert.isTrue(
            h.recorded.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                (typeof event.turnItem.output === "string" ? event.turnItem.output : "").includes(
                  "vendor/b",
                ),
            ),
          );
          h.peer.state.log.length = 0;
          yield* h.start(2, "vendor/a", "low");
          yield* h.peer.finish();
          yield* h.terminal();
          assert.equal(h.mutations()[0], "set_model vendor/a");
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
        }),
      ),
  );

  it.effect(
    "restores native OMP's exact previous model and reasoning when a prompt is rejected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness({ promptError: "Prompt rejected" });
          yield* h.start(1, "vendor/b", "low");
          const terminal = yield* h.terminal();
          if (terminal.type !== "turn.terminal")
            return yield* Effect.die("Missing rejection receipt");
          assert.equal(terminal.status, "failed");
          assert.include(terminal.failure?.message ?? "", "Prompt rejected");
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
          assert.equal(h.peer.state.thinkingLevel, "high");
          assert.equal(h.runtime.providerSession.model, "vendor/a");
        }),
      ),
  );

  for (const command of ["/model", "/new", "/fork", "/review"] as const) {
    it.effect(
      `refuses native OMP ${command} before changing selection or delivering a prompt`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* modelHarness();
            yield* h.start(1, "vendor/b", "low", command).pipe(Effect.flip);
            assert.deepEqual(h.mutations(), []);
            assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
            assert.equal(h.peer.state.prompts.length, 0);
          }),
        ),
    );
  }

  it.effect(
    "refuses a foreign native OMP selection while preserving slash-path text and admitted commands",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness();
          yield* h.runtime
            .startTurn({
              ...h.input,
              modelSelection: {
                instanceId: ProviderInstanceId.make("foreign-omp"),
                model: "vendor/b",
              },
            })
            .pipe(Effect.flip);
          assert.deepEqual(h.mutations(), []);
          assert.equal(h.peer.state.prompts.length, 0);
          for (const [index, text] of ["/Users/alice/notes.md", "/compact the patch"].entries()) {
            yield* h.start(index + 1, "vendor/a", undefined, text);
            yield* h.peer.finish();
            yield* h.terminal();
          }
          assert.deepEqual(
            h.peer.state.prompts.map((prompt) => prompt.frame.message),
            ["/Users/alice/notes.md", "/compact the patch"],
          );
        }),
      ),
  );

  it.effect(
    "admits native OMP messages while background work is pending and refuses commands without mutation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* modelHarness();
          h.peer.state.pendingAsyncWork = true;
          yield* h.start(1, "vendor/a", undefined, "Start a job");
          yield* h.peer.finish();
          yield* h.terminal();
          const before = [...h.mutations()];
          const rejected = yield* h.start(2, "vendor/b", "low", "/help").pipe(Effect.flip);
          assert.include(encodeDiagnostic(rejected), "commands wait until background work settles");
          assert.deepEqual(h.mutations(), before);
          assert.equal(h.peer.state.prompts.length, 1);
          yield* h.terminal();
          yield* h.start(3, "vendor/a", undefined, "New request");
          yield* h.peer.promptDelivered();
          assert.deepEqual(
            h.peer.state.prompts.map((prompt) => prompt.frame.message),
            ["Start a job", "New request"],
          );
          assert.isTrue(
            h.peer.state.prompts.every(
              (prompt) =>
                (prompt.frame as { streamingBehavior?: string }).streamingBehavior === "steer",
            ),
          );
        }),
      ),
  );

  it.effect(
    "refuses a native OMP message when background wake races selection and restores the previous model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let woke = false;
          const release = yield* Deferred.make<void>();
          const switching = yield* Deferred.make<void>();
          const h = yield* modelHarness({
            beforeReply: (frame) => {
              if (frame.type !== "set_model" || frame.modelId !== "b" || woke) return [];
              woke = true;
              return [{ type: "agent_start" }];
            },
            holdReply: (frame) =>
              frame.type === "set_model" && frame.modelId === "b"
                ? Deferred.succeed(switching, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  )
                : Effect.void,
          });
          yield* h.start(1, "vendor/a", undefined, "First request");
          yield* h.peer.finish();
          yield* h.terminal();
          const starting = yield* h
            .start(2, "vendor/b", "low", "Racing request")
            .pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(switching);
          // The runtime's background event must enter its serialized inbox before admission.
          yield* Effect.sleep("30 millis").pipe(TestClock.withLive);
          yield* Deferred.succeed(release, undefined);
          const rejected = yield* Fiber.join(starting);
          assert.equal(rejected._tag, "Failure");
          if (rejected._tag !== "Failure")
            return yield* Effect.die("A racing request stole native background ownership");
          assert.include(encodeDiagnostic(rejected.failure), "resumed background work");
          assert.deepEqual(
            h.peer.state.prompts.map((prompt) => prompt.frame.message),
            ["First request"],
          );
          assert.deepEqual(h.peer.state.model, { provider: "vendor", id: "a" });
          assert.equal(h.peer.state.thinkingLevel, "high");
        }),
      ),
  );

  for (const trigger of ["stop", "process-exit"] as const) {
    it.effect(
      `terminalizes native OMP ordinary calls before ${trigger} receipts and retains partial output`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* ordinaryToolsHarness();
            yield* h.peer.emit([
              nativeToolStart("shell", "bash", { command: "sleep 10" }),
              { type: "tool_stream_update", toolCallId: "shell", update: { text: "partial text" } },
            ]);
            yield* h.takeUntil(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.output === "partial text",
            );
            if (trigger === "stop") yield* h.stop();
            else {
              yield* h.peer.close();
              yield* h.takeUntil((event) => event.type === "turn.terminal");
            }
            const terminal = h.recorded.findIndex((event) => event.type === "turn.terminal");
            const finalTools = h.recorded.flatMap((event, index) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.status !== "running"
                ? [{ item: event.turnItem, index }]
                : [],
            );
            assert.equal(finalTools.length, 1);
            assert.isBelow(finalTools[0]!.index, terminal);
            assert.equal(h.tool("shell")?.status, trigger === "stop" ? "interrupted" : "failed");
            assert.deepEqual(h.tool("shell")?.input, { command: "sleep 10" });
            assert.equal(h.tool("shell")?.output, "partial text");
            assert.equal(h.recorded.filter((event) => event.type === "turn.terminal").length, 1);
          }),
        ),
    );
  }

  it.effect("keeps native OMP failed calls terminal across duplicate frames and Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* ordinaryToolsHarness();
        yield* h.peer.emit([
          nativeToolStart("shell", "bash", { command: "false" }),
          nativeToolEnd(
            "shell",
            "bash",
            { content: [{ type: "text", text: "exit code 1" }] },
            true,
          ),
        ]);
        yield* h.untilTool("shell", "failed");
        yield* h.peer.emit([
          { type: "tool_stream_update", toolCallId: "shell", update: { text: "late" } },
          nativeToolStart("shell", "bash", { command: "echo late" }),
          nativeToolEnd("shell", "bash", {}),
          nativeToolStart("barrier", "read", { path: "barrier.txt" }),
        ]);
        yield* h.untilTool("barrier", "running");
        yield* h.stop();
        assert.equal(
          h.recorded.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId?.endsWith(":shell"),
          ).length,
          2,
        );
        assert.equal(h.tool("shell")?.status, "failed");
        assert.deepEqual(h.tool("shell")?.input, { command: "false" });
        assert.equal(h.tool("shell")?.output, "exit code 1");
      }),
    ),
  );

  it.effect("bounds native OMP tool output while retaining its command through Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* ordinaryToolsHarness();
        yield* h.peer.emit([
          nativeToolStart("shell", "bash", { command: "printf large" }),
          {
            type: "tool_execution_update",
            toolCallId: "shell",
            toolName: "bash",
            partialResult: { content: [{ type: "text", text: "z".repeat(128 * 1024) }] },
          },
        ]);
        const event = yield* h.takeUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            typeof event.turnItem.output === "string",
        );
        assert.isBelow(Buffer.byteLength(encodeDiagnostic(event)), 16 * 1024);
        assert.deepEqual(h.tool("shell")?.input, { command: "printf large" });
        assert.equal(h.runtime.providerSession.status, "running");
        yield* h.stop();
        assert.equal(h.tool("shell")?.status, "interrupted");
        assert.deepEqual(h.tool("shell")?.input, { command: "printf large" });
      }),
    ),
  );

  it.effect("redacts complete native OMP credentials before clipping tool input and output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "opaque-fixture-credential-abcdefghijk";
        const h = yield* ordinaryToolsHarness({ SYNTHETIC_API_KEY: secret });
        const command =
          "x".repeat(4096 - '{"command":"'.length - secret.length + 1) +
          secret +
          "y".repeat(128 * 1024);
        const output = "z".repeat(240 - secret.length + 1) + secret + "w".repeat(128 * 1024);
        yield* h.peer.emit([
          nativeToolStart("shell", "bash", { command }),
          {
            type: "tool_execution_update",
            toolCallId: "shell",
            toolName: "bash",
            partialResult: { content: [{ type: "text", text: output }] },
          },
        ]);
        yield* h.takeUntil(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            typeof event.turnItem.output === "string",
        );
        const encoded = encodeDiagnostic(h.latestTools());
        assert.notInclude(encoded, secret.slice(0, -1));
        assert.include(encoded, "[REDACTED]");
        assert.isBelow(Buffer.byteLength(encoded), 16 * 1024);
        yield* h.stop();
        assert.notInclude(encodeDiagnostic(h.latestTools()), secret.slice(0, -1));
      }),
    ),
  );

  it.effect("preserves native OMP pre-execution stream identity and adopts finalized input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* ordinaryToolsHarness();
        yield* h.peer.emit([
          {
            type: "tool_stream_update",
            toolCallId: "early",
            toolName: "edit",
            update: { text: "patch preview" },
          },
        ]);
        yield* h.untilTool("early", "running");
        const id = h.tool("early")?.id;
        yield* h.peer.emit([
          nativeToolStart("early", "edit", { path: "src/app.ts" }),
          nativeToolEnd("early", "edit", {}),
        ]);
        yield* h.untilTool("early", "completed");
        assert.equal(h.tool("early")?.id, id);
        assert.equal(h.latestTools().length, 1);
        assert.deepEqual(h.tool("early")?.input, { path: "src/app.ts" });
        assert.equal(h.tool("early")?.output, "patch preview");
        assert.equal(h.tool("early")?.toolName, "edit");
        yield* h.stop();
      }),
    ),
  );

  it.effect(
    "fails lost native OMP ordinary calls without closing detached subagents or reusing later turn ownership",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* ordinaryToolsHarness();
          yield* h.peer.emit([
            nativeToolStart("same-id", "read", { path: "first.txt" }),
            {
              type: "subagent_lifecycle",
              payload: {
                id: "child",
                agent: "task",
                detached: true,
                status: "started",
                description: "Detached task",
              },
            },
          ]);
          yield* h.takeUntil(
            (event) => event.type === "subagent.updated" && event.subagent.status === "running",
          );
          h.peer.state.pendingAsyncWork = true;
          yield* h.peer.finish();
          yield* h.takeUntil((event) => event.type === "turn.terminal");
          assert.equal(h.tool("same-id")?.status, "failed");
          assert.equal(
            h.recorded.filter(
              (event) => event.type === "subagent.updated" && event.subagent.status !== "running",
            ).length,
            0,
          );
          yield* h.runtime.startTurn({
            ...h.input,
            runId: RunId.make("later-tool-run"),
            attemptId: RunAttemptId.make("later-tool-attempt"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
            rootNodeId: NodeId.make("later-tool-node"),
          });
          yield* h.peer.promptDelivered();
          yield* h.peer.emit([
            { type: "agent_start" },
            nativeToolStart("same-id", "read", { path: "second.txt" }),
            nativeToolEnd("same-id", "read", {}),
          ]);
          yield* h.untilTool("same-id", "completed");
          const terminals = h
            .latestTools()
            .filter((tool) => tool.nativeItemRef?.nativeId?.endsWith(":same-id"));
          assert.equal(terminals.length, 2);
          assert.equal(new Set(terminals.map((tool) => tool.id)).size, 2);
          assert.equal(new Set(terminals.map((tool) => tool.providerTurnId)).size, 2);
          assert.deepEqual(
            terminals.map((tool) => tool.input),
            [{ path: "first.txt" }, { path: "second.txt" }],
          );
        }),
      ),
  );

  for (const scenario of [
    { version: "18.3.1", rejected: false, filters: 1 },
    { version: "18.3.1", rejected: true, filters: 1 },
    { version: "18.2.8", rejected: false, filters: 0 },
  ] as const) {
    it.effect(
      `keeps native OMP ${scenario.version} startup healthy with event filter rejected=${scenario.rejected}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* imageHarness(1_048_576, {
              version: scenario.version,
              ...(scenario.rejected
                ? { eventFilterError: "Unknown command: set_event_filter" }
                : {}),
            });
            const filters = h.peer.state.frames.filter(
              (frame) => frame.type === "set_event_filter",
            );
            assert.equal(filters.length, scenario.filters);
            if (filters.length) assert.deepEqual(filters[0]?.events, [...OMP_KNOWN_EVENT_TYPES]);
            assert.equal(h.runtime.providerSession.status, "ready");
            yield* h.send(1, "Quiet text turn", []);
            assert.equal(
              h.recorded.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "dynamic_tool" &&
                  event.turnItem.title?.toLowerCase().includes("warning"),
              ),
              false,
            );
          }),
        ),
    );
  }

  it.effect(
    "bounds native OMP startup before catalog discovery when a live peer stays silent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launched = yield* Deferred.make<void>();
          const peer = scriptedOmpRpc({
            models: [],
            initial: { provider: "test", id: "selected" },
            readyDelay: Effect.never,
          });
          const opening = yield* harness(false, {
            makeProcess: (options) =>
              peer
                .makeProcess(options)
                .pipe(Effect.tap(() => Deferred.succeed(launched, undefined))),
          }).pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(launched);
          yield* TestClock.adjust("8 seconds");
          const result = opening.pollUnsafe();
          assert.notEqual(result, undefined);
          if (!result) return yield* Effect.die("Startup did not settle at its deadline");
          assert.equal(Exit.isSuccess(result) && Exit.isFailure(result.value), true);
        }),
      ),
  );

  it.effect("bounds a silent native OMP resume and permits fresh owned state afterward", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const switching = yield* Deferred.make<void>();
        const peer = scriptedOmpRpc({
          models: [],
          initial: { provider: "test", id: "selected" },
          holdReply: (frame) =>
            frame.type === "switch_session"
              ? Deferred.succeed(switching, undefined).pipe(Effect.asVoid)
              : Effect.void,
          silentReply: (frame) => frame.type === "switch_session",
        });
        const h = yield* harness(false, { makeProcess: peer.makeProcess });
        const resuming = yield* h.runtime
          .resumeThread({ providerThread: h.input.providerThread })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(switching);
        yield* TestClock.adjust("2 minutes");
        const result = resuming.pollUnsafe();
        assert.notEqual(result, undefined);
        if (!result) return yield* Effect.die("Resume did not settle at its deadline");
        assert.equal(Exit.isSuccess(result) && Exit.isFailure(result.value), true);
        assert.equal(h.runtime.providerSession.status, "ready");
        // Interrupted client write cannot contaminate a new_session command.
        const fresh = yield* h.runtime.ensureThread({
          threadId: h.input.threadId,
          modelSelection: h.input.modelSelection,
          runtimePolicy: h.input.runtimePolicy,
          existingProviderThread: { ...h.input.providerThread, nativeThreadRef: null },
        });
        assert.notEqual(
          fresh.nativeThreadRef?.nativeId,
          h.input.providerThread.nativeThreadRef?.nativeId,
        );
      }),
    ),
  );

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
