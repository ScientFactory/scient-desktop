// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";
import type { OmpProcessExit, OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const success = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "qualification-request",
  type: "response",
  command,
  success: true,
  data,
});

const defaultModels = [
  {
    provider: "ollama",
    id: "gemma4:12b-it-qat",
    input: ["text", "image"],
  },
  {
    provider: "ollama",
    id: "text-only",
    input: ["text"],
  },
] as const;

const makeClient = (input: {
  readonly events: Queue.Queue<OmpRpcNotification, Cause.Done>;
  readonly sessionDir: string;
  readonly version?: string;
  readonly overrides?: Partial<OmpRpcClient>;
  readonly shutdown?: Effect.Effect<OmpProcessExit, never>;
}) => {
  const sessionFile = NodePath.join(input.sessionDir, "session.jsonl");
  const writeSession = () => {
    NodeFS.mkdirSync(input.sessionDir, { recursive: true });
    NodeFS.writeFileSync(sessionFile, "{}\n");
  };
  const client: OmpRpcClient & {
    readonly version: string;
    readonly shutdown?: Effect.Effect<OmpProcessExit, never>;
  } = {
    version: input.version ?? "18.2.8",
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.fromQueue(input.events),
    flushEvents: () => Queue.offer(input.events, { _tag: "Drain" }).pipe(Effect.asVoid),
    command: () => Effect.succeed(success("command")),
    prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(success("steer")),
    followUp: () => Effect.succeed(success("follow_up")),
    abort: () => Effect.succeed(success("abort")),
    getState: () =>
      Effect.sync(() => {
        writeSession();
        return {
          sessionFile,
          sessionId: "qualification-session",
          isStreaming: false,
          isCompacting: false,
        };
      }),
    getModels: () => Effect.succeed({ models: defaultModels }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(success("set_model")),
    setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
    compact: () => Effect.succeed(success("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
    setHostTools: () => Effect.succeed(success("set_host_tools")),
    setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
    extensionUiResponse: () => Effect.void,
    hostToolUpdate: () => Effect.void,
    hostToolResult: () => Effect.void,
    hostUriResult: () => Effect.void,
    close: () => Effect.void,
    ...input.overrides,
    ...(input.shutdown ? { shutdown: input.shutdown } : {}),
  };
  return client;
};

let rootCounter = 0;

const makeRoot = (label: string) => {
  const root = NodePath.join(
    NodeOS.tmpdir(),
    `scient-omp-qualification-${process.pid}-${label}-${rootCounter++}`,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  return root;
};

const collectRuntimeEvents = (
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  },
  seen: ProviderRuntimeEvent[] = [],
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Queue.offer(events, event).pipe(
          Effect.andThen(Effect.sync(() => seen.push(event))),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped,
    );
    return events;
  });

const takeMatching = <A>(
  queue: Queue.Queue<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> =>
  Queue.take(queue).pipe(
    Effect.flatMap((value) =>
      predicate(value) ? Effect.succeed(value) : takeMatching(queue, predicate),
    ),
  );

const waitForSessionReady = (
  adapter: {
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly status: string }>,
      never,
      never
    >;
  },
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sessions = yield* adapter.listSessions();
      if (sessions.some((session) => session.threadId === threadId && session.status === "ready")) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.fail("Oh My Pi session did not become ready.");
  });

const makeAdapter = (input: {
  readonly root: string;
  readonly instanceId: ProviderInstanceId;
  readonly makeProcess: (options: OmpRpcProcessOptions) => Effect.Effect<
    OmpRpcClient & {
      readonly version: string;
      readonly shutdown?: Effect.Effect<OmpProcessExit, never>;
    },
    never,
    never
  >;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly eventQueueByteLimit?: number;
  readonly nativeEventLogger?: EventNdjsonLogger;
}) =>
  makeOmpAdapter({
    binaryPath: "omp",
    providerInstanceId: input.instanceId,
    stateDir: NodePath.join(input.root, "state"),
    attachmentsDir: NodePath.join(input.root, "attachments"),
    environment: input.environment ?? { PATH: "/usr/bin" },
    homePath: input.homePath,
    ...(input.eventQueueByteLimit === undefined
      ? {}
      : { eventQueueByteLimit: input.eventQueueByteLimit }),
    ...(input.nativeEventLogger ? { nativeEventLogger: input.nativeEventLogger } : {}),
    makeProcess: input.makeProcess,
  });

describe("Oh My Pi production qualification seams", () => {
  it.effect("writes raw Oh My Pi notifications to the shared native event log", () =>
    Effect.gen(function* () {
      const root = makeRoot("native-event-log");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const written: Array<{ readonly event: unknown; readonly threadId: ThreadId | null }> = [];
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-native-log"),
        nativeEventLogger: {
          filePath: "/dev/null",
          write: (event, threadId) =>
            Effect.sync(() => {
              written.push({ event, threadId });
            }),
          close: () => Effect.void,
        },
        makeProcess: (options) =>
          Effect.sync(() => makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-native-log");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "log the raw frames" })
        .pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      yield* Effect.sleep("200 millis").pipe(TestClock.withLive);
      const nativeMethods = (record: { readonly event: unknown }): ReadonlyArray<string> => {
        if (typeof record.event !== "object" || record.event === null) return [];
        const envelope = record.event as { readonly event?: { readonly method?: unknown } };
        return typeof envelope.event?.method === "string" ? [envelope.event.method] : [];
      };
      expect(written.some((record) => record.threadId === threadId)).toBe(true);
      expect(written.some((record) => nativeMethods(record).includes("agent_start"))).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels an accepted turn without killing its process", () =>
    Effect.gen(function* () {
      const root = makeRoot("early-cancel");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-early-cancel"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return { code: 0, forced: false, stderrTail: "" };
              }),
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-early-cancel");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "cancel before agent start" });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const terminal = yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.aborted",
      ).pipe(Effect.timeout("2 seconds"));
      expect(terminal.payload).toMatchObject({ reason: "cancelled" });
      expect(shutdowns).toBe(0);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("settles an early cancel that races a starting agent", () =>
    Effect.gen(function* () {
      const root = makeRoot("cancel-agent-start-race");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-cancel-race"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                // The agent starts after the cancel request is sent but before
                // the acknowledgement arrives, and OMP never reports a
                // terminal end for that turn.
                abort: () =>
                  Effect.gen(function* () {
                    yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
                    // Let the runtime observe the starting agent before the
                    // acknowledgement arrives.
                    for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
                    return success("abort");
                  }),
              },
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return { code: 0, forced: false, stderrTail: "" };
              }),
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-cancel-agent-start-race");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "cancel while starting" });
      yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.timeout("5 seconds"), TestClock.withLive);
      const terminal = yield* takeMatching(runtimeEvents, (event) => event.type === "turn.aborted");
      expect(terminal.payload).toMatchObject({ reason: "cancelled" });
      expect(shutdowns).toBe(0);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not kill a process when cancellation arrives after settlement", () =>
    Effect.gen(function* () {
      const root = makeRoot("settled-cancel");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-settled-cancel"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return { code: 0, forced: false, stderrTail: "" };
              }),
            }),
          ),
      });
      const threadId = ThreadId.make("omp-settled-cancel");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "finish first" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      yield* takeMatching(
        yield* collectRuntimeEvents(adapter),
        (event) => event.type === "turn.completed",
      ).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turn.turnId);
      expect(shutdowns).toBe(0);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("kills and marks uncertain when cancellation exceeds the deadline", () =>
    Effect.gen(function* () {
      const root = makeRoot("cancel-deadline");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-deadline"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: { abort: () => Effect.never },
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return { code: null, forced: true, stderrTail: "" };
              }),
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-cancel-deadline");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "hold the turn open" });
      yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.timeout("5 seconds"), TestClock.withLive);
      const terminal = yield* takeMatching(runtimeEvents, (event) => event.type === "turn.aborted");
      expect(terminal.payload).toMatchObject({ reason: "uncertain" });
      expect(terminal.providerRefs?.providerRequestId).toBe("qualification-request");
      expect(shutdowns).toBe(1);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects cancelled and mismatched resume sessions", () =>
    Effect.gen(function* () {
      const root = makeRoot("resume-failures");
      const instanceId = ProviderInstanceId.make("omp-qualification-resume");
      const firstEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const first = yield* makeAdapter({
        root,
        instanceId,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({ events: firstEvents, sessionDir: options.sessionDir ?? root }),
          ),
      });
      const threadId = ThreadId.make("omp-resume-failures");
      const firstSession = yield* first.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
      });
      const resumeCursor = firstSession.resumeCursor;
      expect(resumeCursor).toBeDefined();
      yield* first.stopAll();

      const cancelledEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const cancelled = yield* makeAdapter({
        root,
        instanceId,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events: cancelledEvents,
              sessionDir: options.sessionDir ?? root,
              overrides: { switchSession: () => Effect.succeed({ cancelled: true }) },
            }),
          ),
      });
      const cancelledError = yield* cancelled
        .startSession({ threadId, cwd: root, runtimeMode: "full-access", resumeCursor })
        .pipe(Effect.flip);
      expect(cancelledError.message).toMatch(/cancelled/);
      yield* cancelled.stopAll();

      const mismatchedEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const mismatched = yield* makeAdapter({
        root,
        instanceId,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events: mismatchedEvents,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                getState: () =>
                  Effect.sync(() => {
                    const other = NodePath.join(options.sessionDir ?? root, "other.jsonl");
                    NodeFS.mkdirSync(options.sessionDir ?? root, { recursive: true });
                    NodeFS.writeFileSync(other, "{}\n");
                    return {
                      sessionFile: other,
                      sessionId: "different-session",
                      isStreaming: false,
                      isCompacting: false,
                    };
                  }),
              },
            }),
          ),
      });
      const mismatchError = yield* mismatched
        .startSession({ threadId, cwd: root, runtimeMode: "full-access", resumeCursor })
        .pipe(Effect.flip);
      expect(mismatchError.message).toMatch(/different session/);
      yield* mismatched.stopAll();

      const resumedEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const resumed = yield* makeAdapter({
        root,
        instanceId,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({ events: resumedEvents, sessionDir: options.sessionDir ?? root }),
          ),
      });
      const resumedSession = yield* resumed.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
        resumeCursor,
      });
      expect(resumedSession.status).toBe("ready");
      yield* resumed.stopAll();

      const pathChangedEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const pathChanged = yield* makeAdapter({
        root,
        instanceId,
        environment: { PATH: "/opt/a-different-tool-directory" },
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({ events: pathChangedEvents, sessionDir: options.sessionDir ?? root }),
          ),
      });
      const pathChangedSession = yield* pathChanged.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
        resumeCursor,
      });
      expect(pathChangedSession.status).toBe("ready");
      yield* pathChanged.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not deadlock a new turn when the desktop event reader is stalled", () =>
    Effect.gen(function* () {
      const root = makeRoot("event-backpressure");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-event-backpressure"),
        makeProcess: (options) =>
          Effect.sync(() => makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const threadId = ThreadId.make("omp-event-backpressure");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* Effect.forEach(
        Array.from({ length: 5_000 }, (_, index) => index),
        (index) =>
          Queue.offer(events, {
            _tag: "Event",
            event: {
              type: "tool_execution_update",
              toolCallId: `queued-${index}`,
              toolName: "queued-tool",
              partialResult: { index },
            },
          }).pipe(Effect.asVoid),
        { discard: true },
      );
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        () => Effect.yieldNow,
        { discard: true },
      );
      const turn = yield* adapter
        .sendTurn({ threadId, input: "start after a stalled reader" })
        .pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      expect(turn.turnId.length).toBeGreaterThan(0);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers the event queue after a byte-budget overflow", () =>
    Effect.gen(function* () {
      const root = makeRoot("event-overflow");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let emitOversized = true;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-event-overflow"),
        eventQueueByteLimit: 64 * 1024,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                prompt: () =>
                  Effect.gen(function* () {
                    if (emitOversized) {
                      yield* Queue.offer(events, {
                        _tag: "Event",
                        event: {
                          type: "message_update",
                          message: { role: "assistant", content: "" },
                          assistantMessageEvent: {
                            type: "text_delta",
                            delta: "x".repeat(256 * 1024),
                          },
                        },
                      });
                      yield* Effect.sleep("10 millis").pipe(TestClock.withLive);
                    }
                    return success("prompt", { agentInvoked: true });
                  }),
              },
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-event-overflow");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "overflow the event queue" });
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, index) => index),
        () => Effect.sleep("1 millis"),
        { discard: true },
      ).pipe(TestClock.withLive);
      expect(yield* adapter.hasSession(threadId)).toBe(false);

      // The failed turn must not end the shared queue: the next session has to
      // be able to start and publish events again.
      emitOversized = false;
      const recoveredThreadId = ThreadId.make("omp-event-overflow-recovered");
      yield* adapter.startSession({
        threadId: recoveredThreadId,
        cwd: root,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter
        .sendTurn({ threadId: recoveredThreadId, input: "deliver after recovery" })
        .pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      expect(turn.turnId.length).toBeGreaterThan(0);
      expect(
        yield* takeMatching(
          runtimeEvents,
          (event) => event.type === "turn.started" && event.threadId === recoveredThreadId,
        ),
      ).toEqual(expect.objectContaining({ threadId: recoveredThreadId }));
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("switches model and thinking level between settled turns", () =>
    Effect.gen(function* () {
      const root = makeRoot("model-switch");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const calls: string[] = [];
      const instanceId = ProviderInstanceId.make("omp-qualification-model-switch");
      const adapter = yield* makeAdapter({
        root,
        instanceId,
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                setModel: (provider, modelId) => {
                  calls.push(`model:${provider}/${modelId}`);
                  return Effect.succeed(success("set_model"));
                },
                setThinkingLevel: (level) => {
                  calls.push(`thinking:${level}`);
                  return Effect.succeed(success("set_thinking_level"));
                },
              },
            }),
          ),
      });
      const threadId = ThreadId.make("omp-model-switch");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "first model",
        modelSelection: createModelSelection(instanceId, "ollama/gemma4:12b-it-qat", [
          { id: "thinkingLevel", value: "high" },
        ]),
      });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      yield* waitForSessionReady(adapter, threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "second model",
        modelSelection: createModelSelection(instanceId, "ollama/text-only", [
          { id: "thinkingLevel", value: "low" },
        ]),
      });
      expect(calls).toEqual([
        "model:ollama/gemma4:12b-it-qat",
        "thinking:high",
        "model:ollama/text-only",
        "thinking:low",
      ]);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses steer for a send while a turn is active and leaves follow-up queuing to Scient",
    () =>
      Effect.gen(function* () {
        const root = makeRoot("steer");
        const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
        const calls: string[] = [];
        const adapter = yield* makeAdapter({
          root,
          instanceId: ProviderInstanceId.make("omp-qualification-steer"),
          makeProcess: (options) =>
            Effect.sync(() =>
              makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
                overrides: {
                  prompt: () => {
                    calls.push("prompt");
                    return Effect.succeed(success("prompt", { agentInvoked: true }));
                  },
                  steer: () => {
                    calls.push("steer");
                    return Effect.succeed(success("steer"));
                  },
                  followUp: () => {
                    calls.push("followUp");
                    return Effect.succeed(success("follow_up"));
                  },
                },
              }),
            ),
        });
        const threadId = ThreadId.make("omp-steer");
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        const first = yield* adapter.sendTurn({ threadId, input: "first" });
        const second = yield* adapter.sendTurn({ threadId, input: "change direction" });
        expect(second.turnId).toBe(first.turnId);
        expect(calls).toEqual(["prompt", "steer"]);
        yield* adapter.stopAll();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not project a user message into the assistant item", () =>
    Effect.gen(function* () {
      const root = makeRoot("user-echo");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-echo"),
        makeProcess: (options) =>
          Effect.sync(() => makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const seen: ProviderRuntimeEvent[] = [];
      const runtimeEvents = yield* collectRuntimeEvents(adapter, seen);
      const threadId = ThreadId.make("omp-user-echo");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "USER_TEXT_SHOULD_NOT_ECHO" });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text: "USER_TEXT_SHOULD_NOT_ECHO" }] },
        },
      });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "USER_TEXT_SHOULD_NOT_ECHO" }] },
        },
      });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "assistant answer" },
        },
      });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.completed").pipe(
        Effect.timeout("2 seconds"),
      );
      const assistantDeltas = seen.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      expect(assistantDeltas).toHaveLength(1);
      expect(
        assistantDeltas.every(
          (event) =>
            event.type !== "content.delta" ||
            !String(event.payload.delta).includes("USER_TEXT_SHOULD_NOT_ECHO"),
        ),
      ).toBe(true);
      const snapshot = yield* adapter.listSessions();
      expect(snapshot[0]?.status).toBe("ready");
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("answers extension confirm and select requests through the adapter", () =>
    Effect.gen(function* () {
      const root = makeRoot("extension-input");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const responses: Array<Record<string, unknown>> = [];
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-extension-input"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                extensionUiResponse: (response) => {
                  responses.push(response);
                  return Effect.void;
                },
              },
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-extension-input");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Confirm",
          message: "Continue?",
        },
      });
      yield* takeMatching(runtimeEvents, (event) => event.type === "user-input.requested").pipe(
        Effect.timeout("2 seconds"),
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("confirm-1"), {
        "confirm-1": "true",
      });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "extension_ui_request",
          id: "select-1",
          method: "select",
          title: "Choose",
          options: ["one", "two"],
        },
      });
      yield* takeMatching(runtimeEvents, (event) => event.type === "user-input.requested").pipe(
        Effect.timeout("2 seconds"),
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("select-1"), {
        "select-1": "two",
      });
      expect(responses).toEqual([
        { id: "confirm-1", confirmed: true },
        { id: "select-1", value: "two" },
      ]);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("answers extension input and stops while the prompt acknowledgement is blocked", () =>
    Effect.gen(function* () {
      const root = makeRoot("blocked-prompt");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const responses: Array<Record<string, unknown>> = [];
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-blocked-prompt"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                // Oh My Pi is busy and has not acknowledged the prompt.
                prompt: () => Effect.never,
                extensionUiResponse: (response) => {
                  responses.push(response);
                  return Effect.void;
                },
              },
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return { code: null, forced: true, stderrTail: "" };
              }),
            }),
          ),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-blocked-prompt");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter
        .sendTurn({ threadId, input: "hold the acknowledgement open" })
        .pipe(Effect.forkScoped);
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "extension_ui_request",
          id: "confirm-blocked",
          method: "confirm",
          title: "Confirm",
          message: "Continue?",
        },
      });
      yield* takeMatching(runtimeEvents, (event) => event.type === "user-input.requested").pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("confirm-blocked"), {
          "confirm-blocked": "true",
        })
        .pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      expect(responses).toEqual([{ id: "confirm-blocked", confirmed: true }]);
      yield* adapter.stopSession(threadId).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(shutdowns).toBe(1);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("marks an unexpected process exit after tool start uncertain", () =>
    Effect.gen(function* () {
      const root = makeRoot("process-exit");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-exit"),
        makeProcess: (options) =>
          Effect.sync(() => makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const runtimeEvents = yield* collectRuntimeEvents(adapter);
      const threadId = ThreadId.make("omp-process-exit");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "start a tool then exit" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "sleep 1" },
        },
      });
      yield* Queue.end(events);
      const terminal = yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.aborted",
      ).pipe(Effect.timeout("2 seconds"));
      expect(terminal.payload).toMatchObject({ reason: "uncertain" });
      expect((yield* adapter.listSessions()).some((session) => session.threadId === threadId)).toBe(
        false,
      );
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("enforces image capability and keeps a 512 KiB image in one frame", () =>
    Effect.gen(function* () {
      const root = makeRoot("images");
      const attachmentsDir = NodePath.join(root, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const imageId = "qualification-image";
      const imageSize = 512 * 1024;
      NodeFS.writeFileSync(
        NodePath.join(attachmentsDir, `${imageId}.png`),
        Buffer.alloc(imageSize, 1),
      );
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let promptImages: ReadonlyArray<{ readonly data: string }> = [];
      const adapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-images"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                prompt: (input) => {
                  promptImages = input.images ?? [];
                  return Effect.succeed(success("prompt", { agentInvoked: true }));
                },
              },
            }),
          ),
      });
      const threadId = ThreadId.make("omp-images");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const attachment = {
        type: "image" as const,
        id: imageId,
        name: "qualification.png",
        mimeType: "image/png",
        sizeBytes: imageSize,
      };
      yield* adapter.sendTurn({
        threadId,
        input: "inspect this image",
        attachments: [attachment],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("omp-qualification-images"),
          "ollama/gemma4:12b-it-qat",
        ),
      });
      expect(promptImages).toHaveLength(1);
      expect(promptImages[0]?.data.length).toBeGreaterThan(imageSize);
      yield* adapter.stopAll();

      const textEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const textAdapter = yield* makeAdapter({
        root,
        instanceId: ProviderInstanceId.make("omp-qualification-images"),
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({ events: textEvents, sessionDir: options.sessionDir ?? root }),
          ),
      });
      const textThreadId = ThreadId.make("omp-images-text-only");
      yield* textAdapter.startSession({
        threadId: textThreadId,
        cwd: root,
        runtimeMode: "full-access",
      });
      const rejected = yield* textAdapter
        .sendTurn({
          threadId: textThreadId,
          input: "inspect this image",
          attachments: [attachment],
          modelSelection: createModelSelection(
            ProviderInstanceId.make("omp-qualification-images"),
            "ollama/text-only",
          ),
        })
        .pipe(Effect.flip);
      expect(rejected.message).toMatch(/does not advertise image/);
      yield* textAdapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps two homes and two processes isolated", () =>
    Effect.gen(function* () {
      const root = makeRoot("two-homes");
      const launches: OmpRpcProcessOptions[] = [];
      const firstHome = NodePath.join(root, "home-a");
      const secondHome = NodePath.join(root, "home-b");
      const makeIsolatedAdapter = (instanceId: ProviderInstanceId, homePath: string) =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
          return yield* makeAdapter({
            root,
            instanceId,
            homePath,
            environment: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: homePath },
            makeProcess: (options) =>
              Effect.sync(() => {
                launches.push(options);
                return makeClient({ events, sessionDir: options.sessionDir ?? root });
              }),
          });
        });
      const first = yield* makeIsolatedAdapter(
        ProviderInstanceId.make("omp-qualification-home-a"),
        firstHome,
      );
      const second = yield* makeIsolatedAdapter(
        ProviderInstanceId.make("omp-qualification-home-b"),
        secondHome,
      );
      const firstThread = ThreadId.make("omp-home-a");
      const secondThread = ThreadId.make("omp-home-b");
      yield* first.startSession({ threadId: firstThread, cwd: root, runtimeMode: "full-access" });
      yield* second.startSession({ threadId: secondThread, cwd: root, runtimeMode: "full-access" });
      expect(launches).toHaveLength(2);
      expect(launches[0]?.env?.PI_CODING_AGENT_DIR).toBe(firstHome);
      expect(launches[1]?.env?.PI_CODING_AGENT_DIR).toBe(secondHome);
      expect(launches[0]?.sessionDir).not.toBe(launches[1]?.sessionDir);
      yield* first.stopAll();
      yield* second.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
