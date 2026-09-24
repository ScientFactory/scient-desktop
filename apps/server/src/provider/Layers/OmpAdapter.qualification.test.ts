// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
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
}) =>
  makeOmpAdapter({
    binaryPath: "omp",
    providerInstanceId: input.instanceId,
    stateDir: NodePath.join(input.root, "state"),
    attachmentsDir: NodePath.join(input.root, "attachments"),
    environment: input.environment ?? { PATH: "/usr/bin" },
    homePath: input.homePath,
    makeProcess: input.makeProcess,
  });

describe("Oh My Pi production qualification seams", () => {
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
