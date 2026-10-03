// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpRpcClient,
  type OmpRpcClient,
  type OmpRpcNotification,
} from "effect-omp-rpc/client";
import {
  OmpRpcCommandError,
  OmpRpcProcessExitedError,
  OmpRpcProtocolError,
} from "effect-omp-rpc/errors";
import type { OmpRpcResponse, OmpRpcState } from "effect-omp-rpc/schema";

import { encodeOmpModelSlug } from "../omp/OmpModel.ts";
import type { OmpProcessExit, OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";
import { ompTarget } from "../omp/OmpTarget.ts";

type FakeProcess = OmpRpcClient & {
  readonly version: string;
  readonly runtimeVersion: string;
  readonly shutdown?: Effect.Effect<OmpProcessExit, never>;
};

class LifecycleTestTimeout extends Schema.TaggedError<LifecycleTestTimeout>()(
  "LifecycleTestTimeout",
  { detail: Schema.String },
) {}

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.optional(Schema.String), type: Schema.optional(Schema.String) }),
  ),
);

const success = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "lifecycle-request",
  type: "response",
  command,
  success: true,
  data,
});

const readyFrame = {
  type: "ready" as const,
  protocolVersion: 1 as const,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
};

const models = [
  { provider: "ollama", id: "gemma4:12b-it-qat", input: ["text", "image"] },
  { provider: "ollama", id: "text-only", input: ["text"] },
] as const;

const makeClient = (input: {
  readonly events: Queue.Queue<OmpRpcNotification, Cause.Done>;
  readonly sessionDir: string;
  readonly overrides?: Partial<OmpRpcClient>;
  readonly shutdown?: Effect.Effect<OmpProcessExit, never>;
  readonly state?: Partial<OmpRpcState>;
}): FakeProcess => {
  const sessionFile = NodePath.join(input.sessionDir, "session.jsonl");
  return {
    version: "18.2.8",
    runtimeVersion: "18.2.8",
    ready: Effect.succeed(readyFrame),
    events: Stream.fromQueue(input.events),
    flushEvents: () => Queue.offer(input.events, { _tag: "Drain" }).pipe(Effect.asVoid),
    command: () => Effect.succeed(success("command")),
    prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(success("steer")),
    followUp: () => Effect.succeed(success("follow_up")),
    abort: () => Effect.succeed(success("abort")),
    getState: () =>
      Effect.sync(() => {
        NodeFS.mkdirSync(input.sessionDir, { recursive: true });
        NodeFS.writeFileSync(sessionFile, "{}\n");
        return {
          sessionFile,
          sessionId: "lifecycle-session",
          isStreaming: false,
          isCompacting: false,
          ...input.state,
        };
      }),
    getModels: () => Effect.succeed({ models }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(success("set_model")),
    setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
    compact: () => Effect.succeed(success("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
    setEventFilter: (events) => Effect.succeed({ events: events === null ? null : [...events] }),
    limits: Effect.succeed({
      maxFrameBytes: readyFrame.maxFrameBytes,
      maxReassembledFrameBytes: readyFrame.maxReassembledFrameBytes,
    }),
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
};

const cleanExit: OmpProcessExit = { code: 0, forced: false, stderrTail: "" };

let rootCounter = 0;
const makeRoot = (label: string) => {
  const root = NodePath.join(
    NodeOS.tmpdir(),
    `scient-omp-lifecycle-${process.pid}-${label}-${rootCounter++}`,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  return root;
};

const lockFiles = (root: string): ReadonlyArray<string> => {
  const sessions = NodePath.join(root, "state", "omp-sessions");
  if (!NodeFS.existsSync(sessions)) return [];
  return NodeFS.readdirSync(sessions, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".session.lock"))
    .map((entry) => NodePath.join(sessions, entry));
};

const makeAdapter = (input: {
  readonly root: string;
  readonly label: string;
  readonly makeProcess: (
    options: OmpRpcProcessOptions,
  ) => Effect.Effect<FakeProcess, OmpRpcProtocolError, Scope.Scope>;
  readonly eventQueueByteLimit?: number;
}) =>
  makeOmpAdapter({
    target: ompTarget,
    binaryPath: "omp",
    providerInstanceId: ProviderInstanceId.make(`omp-lifecycle-${input.label}`),
    stateDir: NodePath.join(input.root, "state"),
    attachmentsDir: NodePath.join(input.root, "attachments"),
    environment: { PATH: "/usr/bin" },
    ...(input.eventQueueByteLimit === undefined
      ? {}
      : { eventQueueByteLimit: input.eventQueueByteLimit }),
    makeProcess: input.makeProcess,
  });

const collect = (
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  seen: Array<ProviderRuntimeEvent>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
      ),
      Effect.forkScoped,
    );
    return queue;
  });

const takeMatching = (
  queue: Queue.Queue<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<ProviderRuntimeEvent, LifecycleTestTimeout> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new LifecycleTestTimeout({ detail: "no matching event" })),
    }),
    TestClock.withLive,
  );

/** Poll real time until `read` holds. */
const waitUntil = (read: Effect.Effect<boolean>, detail: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* read) return;
      yield* Effect.sleep("5 millis");
    }
    return yield* new LifecycleTestTimeout({ detail });
  }).pipe(TestClock.withLive);

const settle = Effect.sleep("50 millis").pipe(TestClock.withLive);

const joinWithin = <A, E>(fiber: Fiber.Fiber<A, E>, duration: string) =>
  Fiber.await(fiber).pipe(
    Effect.timeoutOrElse({
      duration: duration as "1 second",
      orElse: () =>
        Effect.fail(new LifecycleTestTimeout({ detail: `fiber did not finish in ${duration}` })),
    }),
    TestClock.withLive,
  );

const sessionOf = (
  sessions: ReadonlyArray<ProviderSession>,
  threadId: ThreadId,
): ProviderSession | undefined => sessions.find((session) => session.threadId === threadId);

const exitedFor = (seen: ReadonlyArray<ProviderRuntimeEvent>, threadId: ThreadId) =>
  seen.filter((event) => event.threadId === threadId && event.type === "session.exited");

describe("Oh My Pi session ownership", () => {
  it.effect("reports connecting until the startup handshake completes", () =>
    Effect.gen(function* () {
      const root = makeRoot("connecting");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const readyGate = yield* Deferred.make<void>();
      const adapter = yield* makeAdapter({
        root,
        label: "connecting",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                ready: Deferred.await(readyGate).pipe(Effect.as(readyFrame)),
              },
            }),
          ),
      });
      const threadId = ThreadId.make("omp-connecting");
      const start = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* waitUntil(
        adapter
          .listSessions()
          .pipe(Effect.map((all) => sessionOf(all, threadId)?.status === "connecting")),
        "the starting session was not listed as connecting",
      );
      yield* Deferred.succeed(readyGate, undefined);
      const session = yield* Fiber.join(start);
      expect(session.status).toBe("ready");
      expect(sessionOf(yield* adapter.listSessions(), threadId)?.status).toBe("ready");
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stop during start interrupts the start, and a retry keeps its lock", () =>
    Effect.gen(function* () {
      const root = makeRoot("stop-during-start");
      let launches = 0;
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "stop-during-start",
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches += 1;
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              // The first process never finishes its handshake.
              overrides: launches === 1 ? { ready: Effect.never } : {},
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return cleanExit;
              }),
            });
          }),
      });
      const threadId = ThreadId.make("omp-stop-during-start");
      const first = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* waitUntil(
        Effect.sync(() => launches === 1),
        "the first start never launched",
      );
      yield* adapter.stopSession(threadId).pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      const firstExit = yield* joinWithin(first, "2 seconds");
      expect(firstExit._tag).toBe("Failure");
      expect(shutdowns).toBe(1);
      expect(lockFiles(root)).toHaveLength(0);

      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* settle;
      expect(lockFiles(root)).toHaveLength(1);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      expect(lockFiles(root)).toHaveLength(0);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("concurrent stops join the first stop, and a restart waits for it", () =>
    Effect.gen(function* () {
      const root = makeRoot("concurrent-stops");
      const shutdownEntered = yield* Deferred.make<void>();
      const shutdownGate = yield* Deferred.make<void>();
      let launches = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "concurrent-stops",
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches += 1;
            const launch = launches;
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown:
                launch === 1
                  ? Deferred.succeed(shutdownEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(shutdownGate)),
                      Effect.as(cleanExit),
                    )
                  : Effect.succeed(cleanExit),
            });
          }),
      });
      const threadId = ThreadId.make("omp-concurrent-stops");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const firstStop = yield* adapter.stopSession(threadId).pipe(Effect.forkScoped);
      yield* Deferred.await(shutdownEntered);
      const secondStop = yield* adapter.stopSession(threadId).pipe(Effect.forkScoped);
      const restart = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* settle;
      // Neither the second stop nor the restart may finish while the first
      // stop still owns the process and the lock.
      expect(secondStop.pollUnsafe()).toBeUndefined();
      expect(restart.pollUnsafe()).toBeUndefined();
      expect(lockFiles(root)).toHaveLength(1);
      yield* Deferred.succeed(shutdownGate, undefined);
      expect((yield* joinWithin(firstStop, "2 seconds"))._tag).toBe("Success");
      expect((yield* joinWithin(secondStop, "2 seconds"))._tag).toBe("Success");
      const restarted = yield* joinWithin(restart, "2 seconds");
      expect(restarted._tag).toBe("Success");
      expect(launches).toBe(2);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "R1-F4 a stop issued while a restart waits on the previous close cancels the restart",
    () =>
      Effect.gen(function* () {
        const root = makeRoot("stop-pending-restart");
        const shutdownEntered = yield* Deferred.make<void>();
        const shutdownGate = yield* Deferred.make<void>();
        let launches = 0;
        const adapter = yield* makeAdapter({
          root,
          label: "stop-pending-restart",
          makeProcess: (options) =>
            Effect.gen(function* () {
              launches += 1;
              const launch = launches;
              const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
              return makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
                shutdown:
                  launch === 1
                    ? Deferred.succeed(shutdownEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(shutdownGate)),
                        Effect.as(cleanExit),
                      )
                    : Effect.succeed(cleanExit),
              });
            }),
        });
        const threadId = ThreadId.make("omp-stop-pending-restart");
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        const firstStop = yield* adapter.stopSession(threadId).pipe(Effect.forkScoped);
        yield* Deferred.await(shutdownEntered);
        const restart = yield* adapter
          .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
          .pipe(Effect.forkScoped);
        yield* settle;
        // The pending restart is a session a caller (ProviderService) can stop.
        const pendingVisible = yield* adapter.hasSession(threadId);
        const secondStop = yield* adapter.stopSession(threadId).pipe(Effect.forkScoped);
        yield* settle;
        yield* Deferred.succeed(shutdownGate, undefined);
        expect(pendingVisible).toBe(true);
        expect((yield* joinWithin(firstStop, "2 seconds"))._tag).toBe("Success");
        expect((yield* joinWithin(secondStop, "2 seconds"))._tag).toBe("Success");
        const restarted = yield* joinWithin(restart, "2 seconds");
        expect(restarted._tag).toBe("Failure");
        expect(launches).toBe(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(lockFiles(root)).toHaveLength(0);
        yield* adapter.stopAll();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("R1-hardening a failure inside the close still releases the session", () =>
    Effect.gen(function* () {
      const root = makeRoot("close-body-failure");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const realCrypto = yield* Crypto.Crypto;
      let failIds = false;
      const adapter = yield* makeAdapter({
        root,
        label: "close-body-failure",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.succeed(cleanExit),
            }),
          ),
      }).pipe(
        Effect.provideService(Crypto.Crypto, {
          ...realCrypto,
          randomUUIDv4: Effect.suspend(() =>
            failIds ? Effect.die(new Error("event ids unavailable")) : realCrypto.randomUUIDv4,
          ),
        }),
      );
      const threadId = ThreadId.make("omp-close-body-failure");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "work" });
      // The close must stamp the open turn's abort and cannot.
      failIds = true;
      const stopped = yield* adapter
        .stopSession(threadId)
        .pipe(Effect.timeout("2 seconds"), Effect.exit, TestClock.withLive);
      failIds = false;
      expect(stopped._tag).toBe("Success");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(lockFiles(root)).toHaveLength(0);
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restarts immediately after a crash", () =>
    Effect.gen(function* () {
      const root = makeRoot("restart-after-crash");
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      const firstEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let launches = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "restart-after-crash",
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches += 1;
            if (launches === 1) {
              const gated = Deferred.succeed(closeEntered, undefined).pipe(
                Effect.andThen(Deferred.await(closeGate)),
              );
              return makeClient({
                events: firstEvents,
                sessionDir: options.sessionDir ?? root,
                overrides: { close: () => gated },
                shutdown: gated.pipe(Effect.as<OmpProcessExit>({ ...cleanExit, code: 1 })),
              });
            }
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            return makeClient({ events, sessionDir: options.sessionDir ?? root });
          }),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-restart-after-crash");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* Queue.end(firstEvents);
      yield* Deferred.await(closeEntered);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      // Restart while the crashed process is still being reaped.
      const restart = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* settle;
      yield* Deferred.succeed(closeGate, undefined);
      const restarted = yield* joinWithin(restart, "2 seconds");
      expect(restarted._tag).toBe("Success");
      yield* settle;
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(lockFiles(root)).toHaveLength(1);
      const exited = exitedFor(seen, threadId);
      expect(exited).toHaveLength(1);
      expect(exited[0]?.payload).toMatchObject({ exitKind: "error" });
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a startup crash does not leak cleanup into an immediate retry", () =>
    Effect.gen(function* () {
      const root = makeRoot("startup-crash");
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      let launches = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "startup-crash",
        makeProcess: (options) =>
          Effect.gen(function* () {
            launches += 1;
            const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
            if (launches === 1) {
              // The first process dies before its ready frame.
              yield* Queue.end(events);
              const gated = Deferred.succeed(closeEntered, undefined).pipe(
                Effect.andThen(Deferred.await(closeGate)),
              );
              return makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
                overrides: {
                  ready: Effect.fail(new OmpRpcProtocolError({ detail: "RPC stdout ended." })),
                  close: () => gated,
                },
                shutdown: gated.pipe(Effect.as<OmpProcessExit>({ ...cleanExit, code: 1 })),
              });
            }
            return makeClient({ events, sessionDir: options.sessionDir ?? root });
          }),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-startup-crash");
      const first = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(closeEntered);
      const retry = yield* adapter
        .startSession({ threadId, cwd: root, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* settle;
      yield* Deferred.succeed(closeGate, undefined);
      expect((yield* joinWithin(first, "2 seconds"))._tag).toBe("Failure");
      expect((yield* joinWithin(retry, "2 seconds"))._tag).toBe("Success");
      yield* settle;
      expect(lockFiles(root)).toHaveLength(1);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(exitedFor(seen, threadId)).toHaveLength(0);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("start failure at each step frees the lock after the process is shut down", () =>
    Effect.gen(function* () {
      type Step = "makeProcess" | "ready" | "protocol" | "switch_session" | "get_state";
      const steps: ReadonlyArray<Step> = [
        "makeProcess",
        "ready",
        "protocol",
        "switch_session",
        "get_state",
      ];
      for (const step of steps) {
        const root = makeRoot(`start-failure-${step}`);
        const threadId = ThreadId.make(`omp-start-failure-${step}`);
        const label = `start-failure-${step}`;
        // A resume cursor is needed to reach switch_session.
        const seed = yield* makeAdapter({
          root,
          label,
          makeProcess: (options) =>
            Queue.unbounded<OmpRpcNotification, Cause.Done>().pipe(
              Effect.map((events) =>
                makeClient({ events, sessionDir: options.sessionDir ?? root }),
              ),
            ),
        });
        const seeded = yield* seed.startSession({
          threadId,
          cwd: root,
          runtimeMode: "full-access",
        });
        yield* seed.stopAll();

        const order: Array<string> = [];
        let failing = true;
        const adapter = yield* makeAdapter({
          root,
          label,
          makeProcess: (options) =>
            Effect.gen(function* () {
              const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
              const lockPath = NodePath.join(options.sessionDir ?? root, ".session.lock");
              if (!failing) return makeClient({ events, sessionDir: options.sessionDir ?? root });
              if (step === "makeProcess") {
                return yield* new OmpRpcProtocolError({ detail: "Failed to start Oh My Pi." });
              }
              const overrides: Partial<OmpRpcClient> =
                step === "ready"
                  ? { ready: Effect.fail(new OmpRpcProtocolError({ detail: "no ready" })) }
                  : step === "protocol"
                    ? { ready: Effect.succeed({ ...readyFrame, supportedProtocolVersions: [1] }) }
                    : step === "switch_session"
                      ? { switchSession: () => Effect.succeed({ cancelled: true }) }
                      : {
                          getState: () =>
                            Effect.fail(
                              new OmpRpcCommandError({ command: "get_state", detail: "boom" }),
                            ),
                        };
              return makeClient({
                events,
                sessionDir: options.sessionDir ?? root,
                overrides,
                shutdown: Effect.sync(() => {
                  order.push(NodeFS.existsSync(lockPath) ? "shutdown:locked" : "shutdown:unlocked");
                  return cleanExit;
                }),
              });
            }),
        });
        const failed = yield* adapter
          .startSession({
            threadId,
            cwd: root,
            runtimeMode: "full-access",
            resumeCursor: seeded.resumeCursor,
          })
          .pipe(Effect.exit);
        expect(failed._tag, step).toBe("Failure");
        expect(order, step).toEqual(step === "makeProcess" ? [] : ["shutdown:locked"]);
        expect(lockFiles(root), step).toHaveLength(0);
        expect(yield* adapter.hasSession(threadId), step).toBe(false);

        failing = false;
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        expect(lockFiles(root), step).toHaveLength(1);
        yield* adapter.stopAll();
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a protocol failure emits exactly one session exit and a restart succeeds", () =>
    Effect.gen(function* () {
      const root = makeRoot("protocol-fatal");
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const outputs: Array<Queue.Queue<Uint8Array, Cause.Done>> = [];
      let shutdowns = 0;
      const line = (value: unknown) => encoder.encode(`${encodeJson(value)}\n`);
      // A fake `omp` behind the real RPC client, so frames go through decoding.
      const makeWireProcess = (options: OmpRpcProcessOptions) =>
        Effect.gen(function* () {
          const sessionDir = options.sessionDir ?? root;
          const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          outputs.push(stdout);
          const reply = (frame: {
            readonly id?: string | undefined;
            readonly type?: string | undefined;
          }) => {
            const type = frame.type ?? "";
            const data =
              type === "negotiate_protocol"
                ? { protocolVersion: 2 }
                : type === "get_state"
                  ? (() => {
                      NodeFS.mkdirSync(sessionDir, { recursive: true });
                      const sessionFile = NodePath.join(sessionDir, "session.jsonl");
                      NodeFS.writeFileSync(sessionFile, "{}\n");
                      return { sessionFile, sessionId: "wire-session", isStreaming: false };
                    })()
                  : type === "get_available_models"
                    ? { models: [] }
                    : type === "get_available_commands"
                      ? { commands: [] }
                      : {};
            return line({ id: frame.id, type: "response", command: type, success: true, data });
          };
          const client = yield* makeOmpRpcClient({
            stdout: Stream.fromQueue(stdout),
            write: (bytes) =>
              Effect.forEach(
                decoder
                  .decode(bytes)
                  .split("\n")
                  .filter((text) => text.trim().length > 0),
                (text) => Queue.offer(stdout, reply(decodeFrame(text))),
                { discard: true },
              ),
          });
          yield* Queue.offer(stdout, line(readyFrame));
          return {
            ...client,
            version: "18.2.8",
            runtimeVersion: "18.2.8",
            shutdown: Effect.sync(() => {
              shutdowns += 1;
            }).pipe(Effect.andThen(Queue.end(stdout)), Effect.as(cleanExit)),
          } satisfies FakeProcess;
        });
      const adapter = yield* makeAdapter({
        root,
        label: "protocol-fatal",
        makeProcess: makeWireProcess,
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-protocol-fatal");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = outputs[0];
      if (!first) return yield* new LifecycleTestTimeout({ detail: "no wire process" });
      yield* Queue.offer(first, encoder.encode("{not json\n"));
      const exited = yield* takeMatching(
        runtimeEvents,
        (event) => event.threadId === threadId && event.type === "session.exited",
      );
      expect(exited.payload).toMatchObject({ exitKind: "error" });
      expect(String((exited.payload as { readonly reason?: string }).reason)).toMatch(
        /could not read/,
      );
      expect(
        seen.some((event) => event.threadId === threadId && event.type === "runtime.error"),
      ).toBe(true);
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* settle;
      expect(exitedFor(seen, threadId)).toHaveLength(1);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      // The failed process was reaped; only the restarted session holds a lock.
      expect(shutdowns).toBe(1);
      expect(lockFiles(root)).toHaveLength(1);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a user Stop mid-turn cancels the turn and closes the process cleanly", () =>
    Effect.gen(function* () {
      const root = makeRoot("user-stop");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "user-stop",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.succeed(cleanExit),
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-user-stop");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "work for a while" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      yield* adapter.stopSession(threadId);
      const exited = yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      expect(exited.payload).toMatchObject({ exitKind: "graceful" });
      const terminal = seen.filter(
        (event) => event.type === "turn.aborted" || event.type === "turn.completed",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.type).toBe("turn.aborted");
      expect(terminal[0]?.payload).toMatchObject({ reason: "cancelled" });
      expect(lockFiles(root)).toHaveLength(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a stopped runtime cannot deliver late events into a restarted session", () =>
    Effect.gen(function* () {
      const root = makeRoot("late-agent-end");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const nextEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let starts = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "late-agent-end",
        makeProcess: (options) =>
          Effect.sync(() =>
            makeClient({
              events: starts++ === 0 ? events : nextEvents,
              sessionDir: options.sessionDir ?? root,
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-late-agent-end");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "first" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      // Stop closes this runtime before its run reports an end.
      yield* adapter.interruptTurn(threadId, first.turnId);
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.aborted");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const second = yield* adapter.sendTurn({ threadId, input: "second" });
      yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.started" && event.turnId === second.turnId,
      );
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      yield* settle;
      expect(
        seen.some((event) => event.type === "turn.completed" && event.turnId === second.turnId),
      ).toBe(false);
      expect(sessionOf(yield* adapter.listSessions(), threadId)?.status).toBe("running");
      yield* Queue.offer(nextEvents, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(nextEvents, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      const completed = yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.completed",
      );
      expect(completed.turnId).toBe(second.turnId);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("R1-unverified-2 a prompt pending when the process dies is uncertain, not failed", () =>
    Effect.gen(function* () {
      const root = makeRoot("prompt-process-death");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "prompt-process-death",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.succeed({ ...cleanExit, code: 1 }),
              overrides: {
                // OMP dies with the prompt in flight. As in the real client,
                // the waiter fails first and the event stream ends after.
                prompt: () =>
                  Queue.end(events).pipe(
                    Effect.delay("20 millis"),
                    TestClock.withLive,
                    Effect.forkDetach,
                    Effect.andThen(
                      Effect.fail(new OmpRpcProcessExitedError({ detail: "RPC stdout ended." })),
                    ),
                  ),
              },
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-prompt-process-death");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const sent = yield* adapter.sendTurn({ threadId, input: "die now" }).pipe(Effect.exit);
      expect(sent._tag).toBe("Failure");
      yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      const terminal = seen.filter(
        (event) => event.type === "turn.aborted" || event.type === "turn.completed",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ type: "turn.aborted", payload: { reason: "uncertain" } });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("R1-F5 a follow-up sent as the turn settles starts a new turn", () =>
    Effect.gen(function* () {
      const root = makeRoot("follow-up-settle");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const limitsGate = yield* Deferred.make<void>();
      const limitsEntered = yield* Deferred.make<void>();
      let gateLimits = false;
      const commands: Array<string> = [];
      const adapter = yield* makeAdapter({
        root,
        label: "follow-up-settle",
        makeProcess: (options) =>
          Effect.sync(() => {
            const base = makeClient({ events, sessionDir: options.sessionDir ?? root });
            return {
              ...base,
              // The follow-up pauses mid-send while the turn settles.
              limits: Effect.suspend(() =>
                gateLimits
                  ? Deferred.succeed(limitsEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(limitsGate)),
                      Effect.andThen(base.limits),
                    )
                  : base.limits,
              ),
              prompt: (input) =>
                Effect.sync(() => commands.push("prompt")).pipe(Effect.andThen(base.prompt(input))),
              steer: (message, images) =>
                Effect.sync(() => commands.push("steer")).pipe(
                  Effect.andThen(base.steer(message, images)),
                ),
            } satisfies FakeProcess;
          }),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-follow-up-settle");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "first" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      gateLimits = true;
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "and one more thing" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(limitsEntered);
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      const completed = yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.completed",
      );
      expect(completed.turnId).toBe(first.turnId);
      yield* Deferred.succeed(limitsGate, undefined);
      const sent = yield* joinWithin(followUp, "2 seconds");
      expect(sent._tag).toBe("Success");
      const second = sent._tag === "Success" ? sent.value : undefined;
      expect(second?.turnId).toBeDefined();
      expect(second?.turnId).not.toBe(first.turnId);
      yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.started" && event.turnId === second?.turnId,
      );
      expect(commands).toEqual(["prompt", "prompt"]);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const subagentFrame = (status: string): OmpRpcNotification => ({
    _tag: "Event",
    event: {
      type: "subagent_lifecycle",
      payload: { id: "sub-1", status, description: "Review files" },
    },
  });
  const tasksOf = (seen: ReadonlyArray<ProviderRuntimeEvent>, type: string) =>
    seen.filter((event) => event.type === type && event.payload && "taskId" in event.payload);

  it.effect("subagent tasks: Stop closes a foreground turn and its background subagent", () =>
    Effect.gen(function* () {
      const root = makeRoot("subagent-abort");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "subagent-abort",
        makeProcess: (options) =>
          Effect.succeed(makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-subagent-abort");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, subagentFrame("started"));
      yield* takeMatching(runtimeEvents, (event) => event.type === "task.started");
      yield* adapter.interruptTurn(threadId, first.turnId);
      yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      expect(tasksOf(seen, "task.completed")).toMatchObject([
        {
          turnId: first.turnId,
          payload: { taskId: "sub-1", status: "stopped" },
        },
      ]);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("subagent tasks: a session that crashes fails its open subagent", () =>
    Effect.gen(function* () {
      const root = makeRoot("subagent-uncertain");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "subagent-uncertain",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.succeed({ ...cleanExit, code: 1 }),
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-subagent-uncertain");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, subagentFrame("started"));
      yield* takeMatching(runtimeEvents, (event) => event.type === "task.started");
      // OMP dies mid-turn.
      yield* Queue.end(events);
      yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      const closed = tasksOf(seen, "task.completed");
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        turnId: turn.turnId,
        payload: { taskId: "sub-1", status: "failed" },
      });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("subagent tasks: a user stop closes the open subagent as stopped", () =>
    Effect.gen(function* () {
      const root = makeRoot("subagent-stop");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "subagent-stop",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.succeed(cleanExit),
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-subagent-stop");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* Queue.offer(events, subagentFrame("started"));
      yield* takeMatching(runtimeEvents, (event) => event.type === "task.started");
      yield* adapter.stopSession(threadId);
      yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      const closed = tasksOf(seen, "task.completed");
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        turnId: turn.turnId,
        payload: { taskId: "sub-1", status: "stopped" },
      });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("Stop closes the session despite a late native abort acknowledgement", () =>
    Effect.gen(function* () {
      const root = makeRoot("late-abort-ack");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "late-abort-ack",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                abort: () => Effect.sleep("3 seconds").pipe(Effect.as(success("abort"))),
              },
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return cleanExit;
              }),
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-late-abort-ack");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "stop soon" });
      yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      const interrupt = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkScoped);
      yield* settle;
      // OMP stops the run but acknowledges the abort late.
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      const aborted = yield* takeMatching(runtimeEvents, (event) => event.type === "turn.aborted");
      expect(aborted.payload).toMatchObject({ reason: "cancelled" });
      yield* TestClock.adjust("2500 millis");
      expect((yield* joinWithin(interrupt, "1 second"))._tag).toBe("Success");
      expect(shutdowns).toBe(1);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds an interrupt while the session runtime is blocked", () =>
    Effect.gen(function* () {
      const root = makeRoot("blocked-runtime");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let blockState = false;
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "blocked-runtime",
        makeProcess: (options) =>
          Effect.sync(() => {
            const base = makeClient({ events, sessionDir: options.sessionDir ?? root });
            return {
              ...base,
              getState: () => (blockState ? Effect.never : base.getState()),
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return cleanExit;
              }),
            } satisfies FakeProcess;
          }),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-blocked-runtime");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "block the runtime" });
      yield* takeMatching(runtimeEvents, (event) => event.type === "turn.started");
      // The runtime reads state after a model change and OMP never answers.
      blockState = true;
      yield* Queue.offer(events, { _tag: "Event", event: { type: "model_changed" } });
      yield* settle;
      const interrupt = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkScoped);
      yield* settle;
      yield* TestClock.adjust("6 seconds");
      expect((yield* joinWithin(interrupt, "2 seconds"))._tag).toBe("Success");
      const aborted = seen.filter((event) => event.type === "turn.aborted");
      expect(aborted).toHaveLength(1);
      expect(aborted[0]?.payload).toMatchObject({ reason: "cancelled" });
      expect(shutdowns).toBe(1);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(lockFiles(root)).toHaveLength(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("closing the adapter ends its event stream after closing every session", () =>
    Effect.gen(function* () {
      const root = makeRoot("adapter-close");
      const scope = yield* Scope.make("sequential");
      let shutdowns = 0;
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "adapter-close",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return cleanExit;
              }),
            }),
          ),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const drained = yield* Stream.runCollect(adapter.streamEvents).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("omp-adapter-close");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* Scope.close(scope, Exit.void);
      const collected = yield* joinWithin(drained, "2 seconds");
      expect(collected._tag).toBe("Success");
      if (collected._tag === "Success") {
        const exited = Array.from(collected.value).filter(
          (event) => event.threadId === threadId && event.type === "session.exited",
        );
        expect(exited).toHaveLength(1);
        expect(exited[0]?.payload).toMatchObject({ exitKind: "graceful" });
      }
      expect(shutdowns).toBe(1);
      expect(lockFiles(root)).toHaveLength(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("adapter close during crash cleanup leaves no lock or process behind", () =>
    Effect.gen(function* () {
      const root = makeRoot("close-during-crash");
      const scope = yield* Scope.make("sequential");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const closeEntered = yield* Deferred.make<void>();
      const closeGate = yield* Deferred.make<void>();
      let reaped = false;
      const gated = Deferred.succeed(closeEntered, undefined).pipe(
        Effect.andThen(Deferred.await(closeGate)),
        Effect.andThen(
          Effect.sync(() => {
            reaped = true;
          }),
        ),
      );
      const adapter = yield* makeAdapter({
        root,
        label: "close-during-crash",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: { close: () => gated },
              shutdown: gated.pipe(Effect.as<OmpProcessExit>({ ...cleanExit, code: 1 })),
            }),
          ),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const threadId = ThreadId.make("omp-close-during-crash");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* Queue.end(events);
      yield* Deferred.await(closeEntered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* settle;
      yield* Deferred.succeed(closeGate, undefined);
      expect((yield* joinWithin(closing, "2 seconds"))._tag).toBe("Success");
      expect(reaped).toBe(true);
      expect(lockFiles(root)).toHaveLength(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("overflow closes only the offending session and still reports its exit", () =>
    Effect.gen(function* () {
      const root = makeRoot("overflow-isolation");
      const noisyEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const quietEvents = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const noisy = ThreadId.make("omp-overflow-noisy");
      const quiet = ThreadId.make("omp-overflow-quiet");
      let launches = 0;
      let noisyShutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "overflow-isolation",
        eventQueueByteLimit: 64 * 1024,
        makeProcess: (options) =>
          Effect.sync(() => {
            launches += 1;
            if (launches > 1) {
              return makeClient({ events: quietEvents, sessionDir: options.sessionDir ?? root });
            }
            return makeClient({
              events: noisyEvents,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.sync(() => {
                noisyShutdowns += 1;
                return cleanExit;
              }),
              overrides: {
                // One delta larger than the whole per-session budget.
                prompt: () =>
                  Queue.offer(noisyEvents, {
                    _tag: "Event",
                    event: {
                      type: "message_update",
                      message: { role: "assistant", content: "" },
                      assistantMessageEvent: { type: "text_delta", delta: "x".repeat(256 * 1024) },
                    },
                  }).pipe(Effect.as(success("prompt", { agentInvoked: true }))),
              },
            });
          }),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      yield* adapter.startSession({ threadId: noisy, cwd: root, runtimeMode: "full-access" });
      yield* adapter.startSession({ threadId: quiet, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId: noisy, input: "overflow" });
      const exited = yield* takeMatching(
        runtimeEvents,
        (event) => event.threadId === noisy && event.type === "session.exited",
      );
      expect(exited.payload).toMatchObject({ exitKind: "error" });
      yield* waitUntil(
        adapter.hasSession(noisy).pipe(Effect.map((open) => !open)),
        "the noisy session stayed open",
      );
      expect(yield* adapter.hasSession(quiet)).toBe(true);
      const quietTurn = yield* adapter.sendTurn({ threadId: quiet, input: "still here" });
      yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "turn.started" && event.turnId === quietTurn.turnId,
      );
      expect(exitedFor(seen, quiet)).toHaveLength(0);
      expect(noisyShutdowns).toBe(1);
      expect(lockFiles(root)).toHaveLength(1);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("background monitoring obeys the session event budget and still closes cleanly", () =>
    Effect.gen(function* () {
      const root = makeRoot("monitoring-overflow");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      let shutdowns = 0;
      const adapter = yield* makeAdapter({
        root,
        label: "monitoring-overflow",
        eventQueueByteLimit: 1,
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              shutdown: Effect.sync(() => {
                shutdowns += 1;
                return cleanExit;
              }),
            }),
          ),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-monitoring-overflow");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "start background work" });
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "prompt_result",
          id: "lifecycle-request",
          agentInvoked: true,
          status: "completed",
          sessionSettled: false,
        },
      });
      const exited = yield* takeMatching(runtimeEvents, (event) => event.type === "session.exited");
      expect(exited.payload).toMatchObject({ exitKind: "error" });
      expect(shutdowns).toBe(1);
      expect(lockFiles(root)).toHaveLength(0);
      expect(seen.some((event) => event.type === "task.started")).toBe(false);
      expect(seen.find((event) => event.type === "task.completed")?.payload).toMatchObject({
        taskType: "monitor",
        status: "stopped",
      });
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a globally stalled consumer sheds only the largest backlog", () =>
    Effect.gen(function* () {
      const root = makeRoot("global-stall");
      const queues: Array<Queue.Queue<OmpRpcNotification, Cause.Done>> = [];
      const adapter = yield* makeAdapter({
        root,
        label: "global-stall",
        eventQueueByteLimit: 64 * 1024,
        makeProcess: (options) =>
          Queue.unbounded<OmpRpcNotification, Cause.Done>().pipe(
            Effect.tap((events) => Effect.sync(() => queues.push(events))),
            Effect.map((events) => makeClient({ events, sessionDir: options.sessionDir ?? root })),
          ),
      });
      // Nobody reads the adapter's events.
      const threads = Array.from({ length: 8 }, (_, index) =>
        ThreadId.make(`omp-global-stall-${index}`),
      );
      for (const threadId of threads) {
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        // Tool frames belong to an open turn.
        yield* adapter.sendTurn({ threadId, input: "read files" });
      }
      const update = (index: number) => ({
        _tag: "Event" as const,
        event: {
          type: "tool_execution_update",
          toolCallId: `tool-${index}`,
          toolName: "read",
          // Under the tool clip, so each event keeps about 15 KiB.
          partialResult: { output: "z".repeat(15_000) },
        },
      });
      // Thread 0 holds the largest backlog; every thread stays within its own
      // budget, but together they exceed the adapter-wide budget.
      for (const [position, events] of queues.entries()) {
        const count = position === 0 ? 3 : 2;
        for (let index = 0; index < count; index += 1) {
          yield* Queue.offer(events, update(index));
        }
        yield* settle;
      }
      yield* waitUntil(
        adapter
          .hasSession(threads[0] ?? ThreadId.make("missing"))
          .pipe(Effect.map((open) => !open)),
        "the largest backlog was not shed",
      );
      for (const threadId of threads.slice(1)) {
        expect(yield* adapter.hasSession(threadId), threadId).toBe(true);
      }
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clips an oversized tool result instead of closing the session", () =>
    Effect.gen(function* () {
      const root = makeRoot("tool-clip");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const adapter = yield* makeAdapter({
        root,
        label: "tool-clip",
        eventQueueByteLimit: 64 * 1024,
        makeProcess: (options) =>
          Effect.succeed(makeClient({ events, sessionDir: options.sessionDir ?? root })),
      });
      const seen: Array<ProviderRuntimeEvent> = [];
      const runtimeEvents = yield* collect(adapter, seen);
      const threadId = ThreadId.make("omp-tool-clip");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "read a large file" });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: {
          type: "tool_execution_end",
          toolCallId: "tool-large",
          toolName: "read",
          result: { content: [{ type: "text", text: "y".repeat(1024 * 1024) }] },
        },
      });
      const completed = yield* takeMatching(
        runtimeEvents,
        (event) => event.type === "item.completed" && event.itemId !== undefined,
      );
      expect(encodeJson(completed).length).toBeLessThan(64 * 1024);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(exitedFor(seen, threadId)).toHaveLength(0);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("validates a turn before changing the model", () =>
    Effect.gen(function* () {
      const root = makeRoot("validate-first");
      const attachmentsDir = NodePath.join(root, "attachments");
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(attachmentsDir, "validate-image.png"),
        Buffer.alloc(64, 1),
      );
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const calls: Array<string> = [];
      const adapter = yield* makeAdapter({
        root,
        label: "validate-first",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              overrides: {
                setModel: (provider, modelId) =>
                  Effect.sync(() => {
                    calls.push(`model:${provider}/${modelId}`);
                    return success("set_model");
                  }),
              },
            }),
          ),
      });
      const threadId = ThreadId.make("omp-validate-first");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "look at this",
          attachments: [
            {
              type: "image",
              id: "validate-image",
              name: "validate.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
          modelSelection: createModelSelection(
            ProviderInstanceId.make("omp-lifecycle-validate-first"),
            "ollama/text-only",
          ),
        })
        .pipe(Effect.flip);
      expect(rejected.message).toMatch(/does not support images/);
      expect(calls).toEqual([]);
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the previous model and level when the prompt fails", () =>
    Effect.gen(function* () {
      const root = makeRoot("restore-model");
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const calls: Array<string> = [];
      const instanceId = ProviderInstanceId.make("omp-lifecycle-restore-model");
      const adapter = yield* makeAdapter({
        root,
        label: "restore-model",
        makeProcess: (options) =>
          Effect.succeed(
            makeClient({
              events,
              sessionDir: options.sessionDir ?? root,
              state: {
                model: { provider: "ollama", id: "gemma4:12b-it-qat" },
                thinkingLevel: "medium",
              },
              overrides: {
                setModel: (provider, modelId) =>
                  Effect.sync(() => {
                    calls.push(`model:${provider}/${modelId}`);
                    return success("set_model");
                  }),
                setThinkingLevel: (level) =>
                  Effect.sync(() => {
                    calls.push(`thinking:${level}`);
                    return success("set_thinking_level");
                  }),
                prompt: () =>
                  Effect.fail(new OmpRpcCommandError({ command: "prompt", detail: "rejected" })),
                // Levels come only from `thinking.efforts`, as OMP 18.x reports them.
                getModels: () =>
                  Effect.succeed({
                    models: ["gemma4:12b-it-qat", "text-only"].map((id) => ({
                      provider: "ollama",
                      id,
                      reasoning: true,
                      thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
                    })),
                  }),
              },
            }),
          ),
      });
      const threadId = ThreadId.make("omp-restore-model");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const failed = yield* adapter
        .sendTurn({
          threadId,
          input: "switch and fail",
          modelSelection: createModelSelection(instanceId, "ollama/text-only", [
            { id: "thinkingLevel", value: "high" },
          ]),
        })
        .pipe(Effect.exit);
      expect(failed._tag).toBe("Failure");
      expect(calls).toEqual([
        "model:ollama/text-only",
        "thinking:high",
        "model:ollama/gemma4:12b-it-qat",
        "thinking:medium",
      ]);
      expect(sessionOf(yield* adapter.listSessions(), threadId)?.model).toBe(
        encodeOmpModelSlug("ollama", "gemma4:12b-it-qat"),
      );
      yield* adapter.stopAll();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
