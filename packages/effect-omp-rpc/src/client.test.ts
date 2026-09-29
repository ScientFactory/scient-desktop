import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpRpcClient,
  type OmpRpcClientOptions,
  type OmpRpcIo,
  type OmpRpcNotification,
} from "./client.ts";
import {
  OMP_KNOWN_EVENT_TYPES,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
  OmpNegotiateResult,
  type OmpRpcEvent,
} from "./schema.ts";
import {
  OmpRpcCommandError,
  OmpRpcFrameTooLargeError,
  OmpRpcProcessExitedError,
  OmpRpcProtocolError,
  OmpRpcProtocolViolationError,
} from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      type: Schema.optional(Schema.String),
    }),
  ),
);

const line = (value: unknown) => encoder.encode(`${encodeJson(value)}\n`);

const readyFrame = {
  type: "ready" as const,
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};

const decodeNegotiateResult = Schema.decodeUnknownSync(OmpNegotiateResult);
const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const negotiate = <E>(
  stdout: Queue.Queue<Uint8Array, E>,
  stdin: Queue.Queue<string>,
  ready: Partial<typeof readyFrame> = {},
) =>
  Effect.gen(function* () {
    yield* Queue.offer(stdout, line({ ...readyFrame, ...ready }));
    const request = decodeCommand(yield* Queue.take(stdin));
    expect(request.type).toBe("negotiate_protocol");
    yield* Queue.offer(
      stdout,
      line({
        id: request.id,
        type: "response",
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2 },
      }),
    );
  });

interface SentCommand {
  readonly id: string;
  readonly type: string;
}

/** Wait on the live clock so a missing completion fails the test instead of hanging it. */
const awaitLive = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.timeoutOption("2 seconds"), Effect.map(Option.isSome), TestClock.withLive);

/**
 * A client over in-memory stdio. Every notification is collected in `seen`;
 * `ended` completes when the client's event stream ends.
 */
const makeHarness = (
  options: OmpRpcClientOptions = {},
  io: Partial<OmpRpcIo> = {},
  /** Writes whose text matches never complete, like a stalled stdin pipe. */
  stallWrite: (text: string) => boolean = () => false,
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const stdin = yield* Queue.unbounded<string>();
    const seen = yield* Queue.unbounded<OmpRpcNotification>();
    const ended = yield* Deferred.make<void>();
    const client = yield* makeOmpRpcClient(
      {
        stdout: Stream.fromQueue(stdout),
        write: (bytes) => {
          const text = decoder.decode(bytes);
          return stallWrite(text) ? Effect.never : Queue.offer(stdin, text).pipe(Effect.asVoid);
        },
        ...io,
      },
      options,
    );
    yield* client.events.pipe(
      Stream.runForEach((notification) => Queue.offer(seen, notification).pipe(Effect.asVoid)),
      Effect.ensuring(Deferred.succeed(ended, undefined)),
      Effect.forkScoped,
    );
    const takeCommand = Queue.take(stdin).pipe(
      Effect.map((text): SentCommand => {
        const command = decodeCommand(text);
        return { id: command.id, type: command.type ?? "" };
      }),
    );
    const respond = (request: SentCommand, data?: unknown) =>
      Queue.offer(
        stdout,
        line({
          id: request.id,
          type: "response",
          command: request.type,
          success: true,
          ...(data === undefined ? {} : { data }),
        }),
      );
    /**
     * Every notification delivered so far. A barrier event is sent behind the
     * frames already written; a terminated client ends the collection instead.
     */
    const drain = Effect.gen(function* () {
      yield* Queue.offer(stdout, line({ type: "test_barrier" }));
      const delivered: Array<OmpRpcNotification> = [];
      while (true) {
        if (yield* Deferred.isDone(ended)) {
          return [...delivered, ...(yield* Queue.clear(seen))];
        }
        const next = yield* Queue.take(seen).pipe(
          Effect.timeoutOption("1 second"),
          TestClock.withLive,
        );
        if (Option.isNone(next)) return delivered;
        if (next.value._tag === "Event" && next.value.event.type === "test_barrier") {
          return delivered;
        }
        delivered.push(next.value);
      }
    });
    return { stdout, stdin, seen, ended, client, takeCommand, respond, drain };
  });

const eventsOf = (notifications: ReadonlyArray<OmpRpcNotification>): Array<OmpRpcEvent> =>
  notifications.flatMap((notification) =>
    notification._tag === "Event" ? [notification.event] : [],
  );

describe("Oh My Pi RPC client", () => {
  it.effect("negotiates protocol v2 and correlates a command response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* negotiate(stdout, stdin);
        const stateFiber = yield* client.getState().pipe(Effect.forkScoped);
        const request = decodeCommand(yield* Queue.take(stdin));
        expect(request.type).toBe("get_state");
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionId: "session-1", isStreaming: false },
          }),
        );
        expect(yield* Fiber.join(stateFiber)).toMatchObject({ sessionId: "session-1" });
      }),
    ),
  );

  it.effect("returns a prompt acknowledgement before the agent turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const events = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            notification._tag === "Event" && notification.event.type === "agent_end"
              ? Queue.offer(events, "agent_end").pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const promptFiber = yield* client.prompt({ message: "hello" }).pipe(Effect.forkScoped);
        yield* negotiate(stdout, stdin);
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "prompt",
            success: true,
            data: { agentInvoked: true },
          }),
        );
        expect(yield* Fiber.join(promptFiber)).toMatchObject({
          success: true,
          data: { agentInvoked: true },
        });
        expect(yield* Queue.size(events)).toBe(0);
        yield* Queue.offer(stdout, line({ type: "agent_end", isTerminal: true, messages: [] }));
        expect(yield* Queue.take(events)).toBe("agent_end");
      }),
    ),
  );

  it.effect("waits for a prompt acknowledgement past the command timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient(
          {
            stdout: Stream.fromQueue(stdout),
            write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
          },
          { requestTimeoutMs: 50 },
        );
        yield* negotiate(stdout, stdin);
        const promptFiber = yield* client
          .prompt({ message: "slow acknowledgement" })
          .pipe(Effect.forkScoped);
        const request = decodeCommand(yield* Queue.take(stdin));
        // A busy or slow OMP agent can acknowledge `prompt` long after the
        // normal per-command deadline. Failing the turn here would abandon a
        // running agent, so prompt waits for its own response.
        yield* TestClock.adjust("500 millis");
        expect(promptFiber.pollUnsafe()).toBeUndefined();
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "prompt",
            success: true,
            data: { agentInvoked: true },
          }),
        );
        expect(yield* Fiber.join(promptFiber)).toMatchObject({ success: true });
      }),
    ),
  );

  it.effect("surfaces a later failure for the same prompt id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const failures = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            notification._tag === "AsyncCommandFailure"
              ? Queue.offer(failures, notification.id).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const promptFiber = yield* client.prompt({ message: "hello" }).pipe(Effect.forkScoped);
        yield* negotiate(stdout, stdin);
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(
          stdout,
          line({ id: request.id, type: "response", command: "prompt", success: true }),
        );
        yield* Fiber.join(promptFiber);
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "prompt",
            success: false,
            error: "scheduling failed",
          }),
        );
        expect(yield* Queue.take(failures)).toBe(request.id);
      }),
    ),
  );

  it.effect("fails the command that Oh My Pi rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        const failed = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* negotiate(stdout, stdin);
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "get_state",
            success: false,
            error: "not ready",
          }),
        );
        expect(yield* Fiber.join(failed)).toBeInstanceOf(OmpRpcCommandError);
      }),
    ),
  );

  it.effect("releases event buffer space after the host reads an event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const client = yield* makeOmpRpcClient(
          {
            stdout: Stream.fromQueue(stdout),
            write: () => Effect.void,
          },
          { maxQueuedCharacters: 300 },
        );
        const seen = yield* Queue.unbounded<string>();
        yield* client.events.pipe(
          Stream.take(2),
          Stream.runForEach((notification) =>
            Queue.offer(
              seen,
              notification._tag === "Event" ? String(notification.event.type) : notification._tag,
            ).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        yield* Queue.offer(stdout, line(readyFrame));
        yield* Queue.offer(stdout, line({ type: "agent_start", title: "x".repeat(180) }));
        expect(yield* Queue.take(seen)).toBe("agent_start");
        yield* Queue.offer(
          stdout,
          line({ type: "agent_end", isTerminal: true, messages: [], title: "y".repeat(180) }),
        );
        expect(yield* Queue.take(seen)).toBe("agent_end");
      }),
    ),
  );

  it.effect("fails closed when a known event is missing required identity fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const seen = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            Queue.offer(
              seen,
              notification._tag === "Event" ? notification.event.type : notification._tag,
            ).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        yield* Queue.offer(stdout, line(readyFrame));
        yield* Queue.offer(
          stdout,
          line({ type: "subagent_lifecycle", payload: { status: "running" } }),
        );
        expect(yield* Queue.take(seen)).toBe("ProtocolFailure");
        expect(yield* client.events.pipe(Stream.runCollect)).toEqual([]);
      }),
    ),
  );

  it.effect("keeps a session alive when an informational event shape changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const seen = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            Queue.offer(
              seen,
              notification._tag === "Event" ? notification.event.type : notification._tag,
            ).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        yield* Queue.offer(stdout, line(readyFrame));
        // A future OMP release changes an informational event's shape. The
        // session must continue and report it instead of ending the process.
        yield* Queue.offer(stdout, line({ type: "command_output", output: { unexpected: true } }));
        expect(yield* Queue.take(seen)).toBe("UndecodableEvent");
        yield* Queue.offer(stdout, line({ type: "agent_start" }));
        expect(yield* Queue.take(seen)).toBe("agent_start");
        expect(yield* client.ready.pipe(Effect.isSuccess)).toBe(true);
      }),
    ),
  );

  it.effect("keeps an unknown event as an explicit raw variant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const seen = yield* Queue.unbounded<unknown>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) => Queue.offer(seen, notification).pipe(Effect.asVoid)),
          Effect.forkScoped,
        );
        yield* Queue.offer(stdout, line(readyFrame));
        yield* Queue.offer(stdout, line({ type: "future_event", payload: { value: 7 } }));
        expect(yield* Queue.take(seen)).toMatchObject({
          _tag: "Event",
          event: { type: "future_event", raw: { type: "future_event", payload: { value: 7 } } },
        });
        expect(yield* client.ready).toMatchObject({ type: "ready" });
      }),
    ),
  );

  it.effect("accepts a future protocol list that still offers v2", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* Queue.offer(
          stdout,
          line({ ...readyFrame, supportedProtocolVersions: [1, 2, 3, 9] }),
        );
        const request = decodeCommand(yield* Queue.take(stdin));
        expect(request.type).toBe("negotiate_protocol");
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "negotiate_protocol",
            success: true,
            data: { protocolVersion: 2 },
          }),
        );
        expect(
          yield* client.ready.pipe(Effect.map((ready) => ready.supportedProtocolVersions)),
        ).toEqual([1, 2, 3, 9]);
      }),
    ),
  );

  it.effect("delivers one logical frame larger than the streaming event budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const seen = yield* Queue.unbounded<OmpRpcNotification>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) => Queue.offer(seen, notification).pipe(Effect.asVoid)),
          Effect.forkScoped,
        );
        yield* Queue.offer(stdout, line(readyFrame));
        // One chunked logical frame above the 16 MiB streaming budget must still
        // be delivered: the negotiated reassembly ceiling, not the streaming
        // budget, is the limit for a single logical frame.
        const messages = Array.from({ length: 70_000 }, (_, index) => ({
          role: "assistant",
          content: [{ type: "text", text: `message ${index} ${"x".repeat(200)}` }],
        }));
        const json = encodeJson({
          type: "agent_end",
          isTerminal: true,
          messages,
        });
        const bytes = Buffer.from(json, "utf8");
        expect(bytes.byteLength).toBeGreaterThan(16 * 1024 * 1024);
        const count = Math.ceil(bytes.byteLength / OMP_RPC_CHUNK_PAYLOAD_BYTES);
        for (let index = 0; index < count; index += 1) {
          yield* Queue.offer(
            stdout,
            line({
              type: "rpc_chunk",
              chunkId: "rpc-large",
              index,
              count,
              byteLength: bytes.byteLength,
              data: bytes
                .subarray(
                  index * OMP_RPC_CHUNK_PAYLOAD_BYTES,
                  (index + 1) * OMP_RPC_CHUNK_PAYLOAD_BYTES,
                )
                .toString("base64"),
            }),
          );
        }
        // The transport is drained asynchronously, so wait for the frame.
        yield* Effect.sleep("2 seconds").pipe(TestClock.withLive);
        const delivered = yield* Queue.takeAll(seen);
        expect(delivered.filter((notification) => notification._tag === "Event")).toHaveLength(1);
        expect(delivered.filter((notification) => notification._tag === "ProtocolFailure")).toEqual(
          [],
        );
      }),
    ),
  );

  it.effect("rejects an outbound command above the advertised limit with a typed error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        expect(yield* harness.client.limits).toEqual({
          maxFrameBytes: 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
        });
        const failed = yield* harness.client
          .prompt({ message: "x".repeat(1_500_000) })
          .pipe(Effect.flip);
        expect(failed).toBeInstanceOf(OmpRpcFrameTooLargeError);
        expect(failed).toMatchObject({ frameType: "prompt", limitBytes: 1_048_576 });
        expect(failed.message).toContain("1048576");
        expect(yield* Queue.size(harness.stdin)).toBe(0);
        // The rejected write does not terminate the client.
        const state = yield* harness.client.getState().pipe(Effect.forkScoped);
        const request = yield* harness.takeCommand;
        yield* harness.respond(request, { sessionId: "still-alive" });
        expect(yield* Fiber.join(state)).toMatchObject({ sessionId: "still-alive" });
      }),
    ),
  );

  it.effect("reports every written frame and every ready and response frame it reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const traced: Array<{ readonly direction: string; readonly type: unknown }> = [];
        const harness = yield* makeHarness({
          onFrame: ({ direction, frame }) =>
            Effect.sync(() => {
              traced.push({ direction, type: frame.type });
            }),
        });
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.forkScoped);
        const request = yield* harness.takeCommand;
        yield* harness.respond(request, { sessionId: "traced" });
        yield* Fiber.join(state);
        yield* harness.client.extensionUiResponse({ id: "ui-1", cancelled: true });
        yield* Queue.offer(harness.stdout, line({ type: "agent_start" }));
        yield* harness.drain;
        expect(traced).toEqual([
          { direction: "inbound", type: "ready" },
          { direction: "outbound", type: "negotiate_protocol" },
          { direction: "inbound", type: "response" },
          { direction: "outbound", type: "get_state" },
          { direction: "inbound", type: "response" },
          { direction: "outbound", type: "extension_ui_response" },
        ]);
      }),
    ),
  );

  it.effect("writes a command within the negotiated frame limit as one line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin, { maxFrameBytes: 2 * 1024 * 1024 });
        expect((yield* harness.client.limits).maxFrameBytes).toBe(2 * 1024 * 1024);
        const message = "y".repeat(1_500_000);
        const prompt = yield* harness.client.prompt({ message }).pipe(Effect.forkScoped);
        const written = yield* Queue.take(harness.stdin);
        expect(written.endsWith("\n")).toBe(true);
        expect(written.indexOf("\n")).toBe(written.length - 1);
        const request = decodeFrame(written);
        expect(request).toMatchObject({ type: "prompt", message });
        yield* harness.respond({ id: String(request.id), type: "prompt" }, { agentInvoked: true });
        expect(yield* Fiber.join(prompt)).toMatchObject({ success: true });
      }),
    ),
  );

  it.effect("close ends events and fails waiters even when transport close fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeAttempts = yield* Ref.make(0);
        const harness = yield* makeHarness(
          {},
          {
            close: Ref.update(closeAttempts, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail(new OmpRpcProcessExitedError({ detail: "close failed" }))),
            ),
          },
        );
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* harness.takeCommand;
        yield* harness.client.close();
        expect(yield* Ref.get(closeAttempts)).toBe(1);
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProcessExitedError);
        expect(yield* awaitLive(Deferred.await(harness.ended))).toBe(true);
        const late = yield* harness.client.getCommands().pipe(Effect.flip);
        expect(late).toBeInstanceOf(OmpRpcProcessExitedError);
        expect(yield* Queue.size(harness.stdin)).toBe(0);
      }),
    ),
  );

  it.effect("supports host registration and validates switch-session results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* negotiate(stdout, stdin);
        const hostToolsFiber = yield* client
          .setHostTools([{ name: "echo", description: "Echo", parameters: {} }])
          .pipe(Effect.forkScoped);
        const hostToolsRequest = decodeCommand(yield* Queue.take(stdin));
        expect(hostToolsRequest.type).toBe("set_host_tools");
        yield* Queue.offer(
          stdout,
          line({
            id: hostToolsRequest.id,
            type: "response",
            command: "set_host_tools",
            success: true,
            data: { toolNames: ["echo"] },
          }),
        );
        expect(yield* Fiber.join(hostToolsFiber)).toMatchObject({ success: true });

        const switchFiber = yield* client
          .switchSession("/state/session.jsonl")
          .pipe(Effect.forkScoped);
        const switchRequest = decodeCommand(yield* Queue.take(stdin));
        expect(switchRequest.type).toBe("switch_session");
        yield* Queue.offer(
          stdout,
          line({
            id: switchRequest.id,
            type: "response",
            command: "switch_session",
            success: true,
            data: { cancelled: false },
          }),
        );
        expect(yield* Fiber.join(switchFiber)).toEqual({ cancelled: false });
      }),
    ),
  );

  it.effect("rejects an invalid protocol negotiation result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(() => decodeNegotiateResult({ protocolVersion: 1 })).toThrow();
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const seen = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            Queue.offer(seen, notification._tag).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        const state = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* Queue.offer(stdout, line(readyFrame));
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "negotiate_protocol",
            success: true,
            data: { protocolVersion: 1 },
          }),
        );
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(yield* Queue.take(seen)).toBe("ProtocolFailure");
      }),
    ),
  );

  it.effect("terminalizes the client when the ready frame is invalid", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        });
        yield* Queue.offer(stdout, line({ type: "ready", protocolVersion: 1 }));
        expect(yield* client.ready.pipe(Effect.flip)).toBeInstanceOf(OmpRpcProtocolViolationError);
      }),
    ),
  );

  it.effect("terminalizes the client when a known response omits its id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const seen = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            Queue.offer(seen, notification._tag).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        const state = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* negotiate(stdout, stdin);
        yield* Queue.take(stdin);
        yield* Queue.offer(stdout, line({ type: "response", command: "get_state", success: true }));
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(yield* Queue.take(seen)).toBe("ProtocolFailure");
      }),
    ),
  );

  it.effect("terminalizes the client when a response command does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const seen = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* client.events.pipe(
          Stream.runForEach((notification) =>
            Queue.offer(seen, notification._tag).pipe(Effect.asVoid),
          ),
          Effect.forkScoped,
        );
        const failed = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* negotiate(stdout, stdin);
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(
          stdout,
          line({
            id: request.id,
            type: "response",
            command: "prompt",
            success: true,
          }),
        );
        expect(yield* Fiber.join(failed)).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(yield* Queue.take(seen)).toBe("ProtocolFailure");
        yield* Queue.offer(stdout, line({ type: "agent_end", isTerminal: true }));
        expect(yield* Queue.size(seen)).toBe(0);
      }),
    ),
  );
});

const bytesOf = (text: string) => encoder.encode(text);
const concatBytes = (...parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

describe("Oh My Pi RPC client transport", () => {
  it.effect("accepts CRLF line endings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.stdout, bytesOf(`${encodeJson(readyFrame)}\r\n`));
        const request = yield* harness.takeCommand;
        yield* Queue.offer(
          harness.stdout,
          bytesOf(
            `${encodeJson({ id: request.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } })}\r\n${encodeJson({ type: "agent_start" })}\r\n`,
          ),
        );
        expect(eventsOf(yield* harness.drain).map((event) => event.type)).toEqual(["agent_start"]);
      }),
    ),
  );

  it.effect("reassembles a line split across stdout chunks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(harness.stdout, bytesOf('{"type":"notice","level":"info","mes'));
        yield* Queue.offer(harness.stdout, bytesOf('sage":"split"}\n'));
        expect(eventsOf(yield* harness.drain)).toMatchObject([
          { type: "notice", message: "split" },
        ]);
      }),
    ),
  );

  it.effect("decodes a multibyte character split across stdout chunks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const bytes = line({ type: "notice", level: "info", message: "café ∑ 😀" });
        const emoji = bytes.indexOf(0xf0);
        yield* Queue.offer(harness.stdout, bytes.subarray(0, emoji + 2));
        yield* Queue.offer(harness.stdout, bytes.subarray(emoji + 2));
        expect(eventsOf(yield* harness.drain)).toMatchObject([
          { type: "notice", message: "café ∑ 😀" },
        ]);
      }),
    ),
  );

  it.effect("treats invalid UTF-8 in a physical line as a protocol violation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(
          harness.stdout,
          concatBytes(
            bytesOf('{"type":"notice","level":"info","message":"a'),
            new Uint8Array([0xff]),
            bytesOf('b"}\n'),
          ),
        );
        const delivered = yield* harness.drain;
        expect(eventsOf(delivered)).toEqual([]);
        expect(delivered).toMatchObject([{ _tag: "ProtocolFailure" }]);
      }),
    ),
  );

  it.effect("flushes the UTF-8 decoder at end of stdout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        // The final unterminated line ends in a truncated multibyte sequence.
        // Dropping those bytes silently would accept a frame OMP never sent.
        yield* Queue.offer(
          harness.stdout,
          concatBytes(bytesOf('{"type":"agent_start"}'), new Uint8Array([0xf0, 0x9f])),
        );
        yield* Queue.end(harness.stdout);
        expect(yield* awaitLive(Deferred.await(harness.ended))).toBe(true);
        const delivered = yield* Queue.clear(harness.seen);
        expect(eventsOf(delivered)).toEqual([]);
        expect(delivered).toMatchObject([{ _tag: "ProtocolFailure" }]);
      }),
    ),
  );

  it.effect("reassembles an rpc_chunk response through the client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.forkScoped);
        const request = yield* harness.takeCommand;
        const sessionName = `${"n".repeat(OMP_RPC_CHUNK_PAYLOAD_BYTES - 40)}😀${"m".repeat(1_100_000)}`;
        const bytes = Buffer.from(
          encodeJson({
            id: request.id,
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionName },
          }),
          "utf8",
        );
        const count = Math.ceil(bytes.byteLength / OMP_RPC_CHUNK_PAYLOAD_BYTES);
        for (let index = 0; index < count; index += 1) {
          yield* Queue.offer(
            harness.stdout,
            line({
              type: "rpc_chunk",
              chunkId: "rpc-state",
              index,
              count,
              byteLength: bytes.byteLength,
              data: bytes
                .subarray(
                  index * OMP_RPC_CHUNK_PAYLOAD_BYTES,
                  (index + 1) * OMP_RPC_CHUNK_PAYLOAD_BYTES,
                )
                .toString("base64"),
            }),
          );
        }
        expect((yield* Fiber.join(state)).sessionName).toBe(sessionName);
      }),
    ),
  );

  it.effect("rejects an oversized physical line and names the violation to waiters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* harness.takeCommand;
        // Streamed without a newline: the client must not buffer past the limit.
        for (let index = 0; index < 3; index += 1) {
          yield* Queue.offer(harness.stdout, bytesOf("x".repeat(400_000)));
        }
        const failure = yield* Fiber.join(state);
        expect(failure).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(failure.message).toContain("physical frame limit");
        expect(yield* awaitLive(Deferred.await(harness.ended))).toBe(true);
      }),
    ),
  );

  it.effect("fails pending commands when stdout ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        const compact = yield* harness.client.compact().pipe(Effect.flip, Effect.forkScoped);
        yield* harness.takeCommand;
        yield* harness.takeCommand;
        yield* Queue.end(harness.stdout);
        const failures = [yield* Fiber.join(state), yield* Fiber.join(compact)];
        for (const failure of failures) {
          expect(failure).toBeInstanceOf(OmpRpcProcessExitedError);
          expect(failure.message).toBe("RPC stdout ended.");
        }
        expect(yield* awaitLive(Deferred.await(harness.ended))).toBe(true);
      }),
    ),
  );
});

describe("Oh My Pi RPC client commands", () => {
  it.effect("fails only the timed-out command and names it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ requestTimeoutMs: 50 });
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        const request = yield* harness.takeCommand;
        yield* TestClock.adjust("100 millis");
        const failure = yield* Fiber.join(state);
        expect(failure).toBeInstanceOf(OmpRpcCommandError);
        expect(failure).toMatchObject({
          command: "get_state",
          requestId: request.id,
          code: "timeout",
        });
        expect(failure.message).toContain("get_state");
        // A late response for the abandoned request is ignored, and the
        // client keeps serving other commands.
        yield* harness.respond(request, { sessionId: "late" });
        const commands = yield* harness.client.getCommands().pipe(Effect.forkScoped);
        const next = yield* harness.takeCommand;
        yield* harness.respond(next, { commands: [] });
        expect(yield* Fiber.join(commands)).toEqual({ commands: [] });
        expect(
          (yield* harness.drain).filter((notification) => notification._tag === "ProtocolFailure"),
        ).toEqual([]);
      }),
    ),
  );

  it.effect("waits past the ordinary timeout for compact, switch_session and abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const calls = [
          harness.client.compact(),
          harness.client.switchSession("/state/session.jsonl"),
          harness.client.abort(),
        ] as const;
        const data = [{ summary: "done" }, { cancelled: false }, undefined];
        for (const [index, call] of calls.entries()) {
          const fiber = yield* Effect.forkScoped(call);
          const request = yield* harness.takeCommand;
          yield* TestClock.adjust("60 seconds");
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* harness.respond(request, data[index]);
          expect(yield* Fiber.join(fiber).pipe(Effect.isSuccess)).toBe(true);
        }
      }),
    ),
  );

  it.effect("surfaces an id-less parse failure with the agent's error text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(
          harness.stdout,
          line({
            type: "response",
            command: "parse",
            success: false,
            error: "Failed to parse command: JSON Parse error: Unexpected EOF",
          }),
        );
        yield* Queue.offer(harness.stdout, line({ type: "agent_start" }));
        const delivered = yield* harness.drain;
        expect(delivered[0]).toEqual({
          _tag: "CommandParseFailure",
          error: "Failed to parse command: JSON Parse error: Unexpected EOF",
        });
        expect(eventsOf(delivered).map((event) => event.type)).toEqual(["agent_start"]);
      }),
    ),
  );

  it.effect(
    "fails only the waiter of an unknown command that a release rejects without its id",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* negotiate(harness.stdout, harness.stdin);
          const filter = yield* harness.client
            .setEventFilter(OMP_KNOWN_EVENT_TYPES)
            .pipe(Effect.flip, Effect.forkScoped);
          yield* harness.takeCommand;
          yield* Queue.offer(
            harness.stdout,
            line({
              type: "response",
              command: "set_event_filter",
              success: false,
              error: "Unknown command: set_event_filter",
            }),
          );
          const error = yield* Fiber.join(filter);
          expect(error).toMatchObject({
            _tag: "OmpRpcCommandError",
            command: "set_event_filter",
            code: "unknown_command",
            detail: "Unknown command: set_event_filter",
          });
          // The client stays usable.
          const state = yield* harness.client.getState().pipe(Effect.forkScoped);
          const request = yield* harness.takeCommand;
          yield* harness.respond(request, { isStreaming: false, isCompacting: false });
          expect(yield* Fiber.join(state).pipe(Effect.isSuccess)).toBe(true);
        }),
      ),
  );

  it.effect("surfaces an ambiguous id-less rejection without ending the client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(
          harness.stdout,
          line({
            type: "response",
            command: "set_event_filter",
            success: false,
            error: "Unknown command: set_event_filter",
          }),
        );
        yield* Queue.offer(harness.stdout, line({ type: "agent_start" }));
        const delivered = yield* harness.drain;
        expect(delivered[0]).toEqual({
          _tag: "CommandParseFailure",
          error: "Unknown command: set_event_filter",
        });
        expect(eventsOf(delivered).map((event) => event.type)).toEqual(["agent_start"]);
      }),
    ),
  );

  it.effect("ends the event stream and fails waiters when the client scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: () => Effect.void,
        }).pipe(Scope.provide(scope));
        const collected = yield* client.events.pipe(Stream.runCollect, Effect.forkScoped);
        const state = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);
        expect(yield* awaitLive(Fiber.join(collected))).toBe(true);
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProcessExitedError);
      }),
    ),
  );

  it.effect("frees the pending slot of a command interrupted during its write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({}, {}, (text) => text.includes('"get_state"'));
        yield* negotiate(harness.stdout, harness.stdin);
        const blocked = yield* Effect.forEach(Array.from({ length: 32 }), () =>
          harness.client.getState().pipe(Effect.forkScoped),
        );
        for (let step = 0; step < 10; step += 1) yield* Effect.yieldNow;
        // All 32 slots are taken, so a 33rd command is refused atomically.
        const refused = yield* harness.client.getCommands().pipe(Effect.flip);
        expect(refused).toBeInstanceOf(OmpRpcProtocolError);
        yield* Fiber.interruptAll(blocked);
        const commands = yield* harness.client.getCommands().pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.yieldNow;
        // A leaked slot refuses the command instead of writing it.
        expect(yield* Queue.size(harness.stdin)).toBe(1);
        const request = yield* harness.takeCommand;
        expect(request.type).toBe("get_available_commands");
        yield* harness.respond(request, { commands: [] });
        expect(yield* Fiber.join(commands)).toEqual(Exit.succeed({ commands: [] }));
      }),
    ),
  );

  it.effect("treats a second ready frame as a protocol violation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* harness.takeCommand;
        yield* Queue.offer(harness.stdout, line(readyFrame));
        expect(yield* awaitLive(Fiber.join(state))).toBe(true);
        const failure = yield* Fiber.join(state);
        expect(failure).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(failure.message).toContain("ready");
        expect(yield* awaitLive(Deferred.await(harness.ended))).toBe(true);
      }),
    ),
  );

  it.effect("does not run the transport close in the fiber that hit a violation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeStarted = yield* Deferred.make<void>();
        const harness = yield* makeHarness(
          { requestTimeoutMs: 50 },
          { close: Deferred.succeed(closeStarted, undefined).pipe(Effect.andThen(Effect.never)) },
          (text) => text.includes('"get_state"'),
        );
        yield* negotiate(harness.stdout, harness.stdin);
        const state = yield* harness.client.getState().pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
        // The stalled write is fatal, but its caller returns while the slow
        // transport close continues elsewhere.
        expect(yield* awaitLive(Fiber.join(state))).toBe(true);
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProtocolViolationError);
        expect(yield* awaitLive(Deferred.await(closeStarted))).toBe(true);
      }),
    ),
  );

  it.effect("keeps the frame type when a caller passes its own type", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* harness.client.extensionUiResponse({
          type: "host_tool_result",
          id: "ui-1",
          value: "a",
        });
        yield* harness.client.hostToolUpdate({ type: "prompt", id: "tool-1", partialResult: {} });
        yield* harness.client.hostToolResult({ type: "abort", id: "tool-1", result: {} });
        yield* harness.client.hostUriResult({ type: "prompt", id: "uri-1", content: "x" });
        const types = [];
        for (let index = 0; index < 4; index += 1) {
          types.push(decodeFrame(yield* Queue.take(harness.stdin)).type);
        }
        expect(types).toEqual([
          "extension_ui_response",
          "host_tool_update",
          "host_tool_result",
          "host_uri_result",
        ]);
      }),
    ),
  );

  it.effect("pins the event filter to the known event types", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const pinned = yield* harness.client
          .setEventFilter(OMP_KNOWN_EVENT_TYPES)
          .pipe(Effect.forkScoped);
        const written = decodeFrame(yield* Queue.take(harness.stdin));
        expect(written).toMatchObject({ type: "set_event_filter", events: OMP_KNOWN_EVENT_TYPES });
        yield* harness.respond(
          { id: String(written.id), type: "set_event_filter" },
          { events: OMP_KNOWN_EVENT_TYPES },
        );
        expect(yield* Fiber.join(pinned)).toEqual({ events: OMP_KNOWN_EVENT_TYPES });

        const cleared = yield* harness.client.setEventFilter(null).pipe(Effect.forkScoped);
        const clear = decodeFrame(yield* Queue.take(harness.stdin));
        expect(clear).toMatchObject({ type: "set_event_filter", events: null });
        yield* harness.respond(
          { id: String(clear.id), type: "set_event_filter" },
          { events: null },
        );
        expect(yield* Fiber.join(cleared)).toEqual({ events: null });
      }),
    ),
  );

  it("derives the known event types from the event schema", () => {
    expect(OMP_KNOWN_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "agent_end",
        "message_end",
        "host_uri_request",
        "subagent_progress",
        "auto_retry_start",
        "session_settled",
        "command_output",
      ]),
    );
    expect(new Set(OMP_KNOWN_EVENT_TYPES).size).toBe(OMP_KNOWN_EVENT_TYPES.length);
    expect(OMP_KNOWN_EVENT_TYPES).not.toContain("irc_message");
  });
});

describe("Oh My Pi RPC client decoding", () => {
  it.effect("decodes models with unknown input kinds and thinking metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const models = yield* harness.client.getModels().pipe(Effect.forkScoped);
        const request = yield* harness.takeCommand;
        yield* harness.respond(request, {
          models: [
            {
              provider: "anthropic",
              id: "claude-opus",
              reasoning: true,
              input: ["text", "image", "audio"],
              thinking: {
                mode: "anthropic-adaptive",
                efforts: ["low", "medium", "high", "xhigh"],
                defaultLevel: "high",
                effortMap: { xhigh: "max" },
              },
            },
          ],
        });
        expect((yield* Fiber.join(models)).models).toEqual([
          {
            provider: "anthropic",
            id: "claude-opus",
            reasoning: true,
            input: ["text", "image", "audio"],
            thinking: {
              mode: "anthropic-adaptive",
              efforts: ["low", "medium", "high", "xhigh"],
              defaultLevel: "high",
            },
          },
        ]);
      }),
    ),
  );

  it.effect("delivers a host_uri_request with an unknown operation to the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(
          harness.stdout,
          line({ type: "host_uri_request", id: "uri-1", operation: "delete", url: "db://rows/1" }),
        );
        expect(eventsOf(yield* harness.drain)).toMatchObject([
          { type: "host_uri_request", id: "uri-1", operation: "delete", url: "db://rows/1" },
        ]);
      }),
    ),
  );

  it.effect("keeps error, retry, compaction and settle fields through the projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        const frames = [
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
            errorMessage: "429 Too Many Requests",
            errorId: 7,
          },
          { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 exhausted" },
          {
            type: "auto_compaction_end",
            action: "context-full",
            aborted: false,
            willRetry: false,
            errorMessage: "compaction failed",
          },
          {
            type: "auto_compaction_end",
            action: "shake",
            aborted: false,
            willRetry: false,
            skipped: true,
            result: { summary: "kept" },
          },
          {
            type: "message_end",
            messageId: "msg-1",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "401 Unauthorized",
              errorId: 3,
              provider: "anthropic",
            },
          },
          { type: "agent_end", messages: [], isTerminal: true, yielded: false },
          {
            type: "prompt_result",
            id: "7",
            agentInvoked: true,
            status: "error",
            sessionSettled: true,
          },
          { type: "session_settled" },
        ];
        for (const frame of frames) yield* Queue.offer(harness.stdout, line(frame));
        const delivered = yield* harness.drain;
        expect(delivered.filter((notification) => notification._tag !== "Event")).toEqual([]);
        const events = eventsOf(delivered);
        expect(events[0]).toMatchObject({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: "429 Too Many Requests",
        });
        expect(events[1]).toMatchObject({
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: "429 exhausted",
        });
        expect(events[2]).toMatchObject({
          type: "auto_compaction_end",
          errorMessage: "compaction failed",
          aborted: false,
        });
        expect(events[3]).toMatchObject({
          type: "auto_compaction_end",
          skipped: true,
          result: { summary: "kept" },
        });
        expect(events[4]).toMatchObject({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "401 Unauthorized",
            errorId: 3,
          },
        });
        expect(events[5]).toMatchObject({ type: "agent_end", isTerminal: true, yielded: false });
        expect(events[6]).toMatchObject({
          type: "prompt_result",
          status: "error",
          sessionSettled: true,
        });
        expect(events[7]).toMatchObject({ type: "session_settled" });
      }),
    ),
  );

  it.effect("keeps stopReason and errorMessage from a drifted message_end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        yield* Queue.offer(
          harness.stdout,
          line({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              stopReason: "error",
              errorMessage: "401 Unauthorized",
              isError: "drifted",
            },
          }),
        );
        const delivered = yield* harness.drain;
        expect(delivered.filter((notification) => notification._tag === "ProtocolFailure")).toEqual(
          [],
        );
        expect(delivered).toContainEqual(
          expect.objectContaining({ _tag: "UndecodableEvent", eventType: "message_end" }),
        );
        expect(eventsOf(delivered)).toMatchObject([
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              stopReason: "error",
              errorMessage: "401 Unauthorized",
            },
          },
        ]);
      }),
    ),
  );

  it.effect("reports each drifted event type once per client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* negotiate(harness.stdout, harness.stdin);
        for (let index = 0; index < 5; index += 1) {
          yield* Queue.offer(
            harness.stdout,
            line({ type: "command_output", output: { unexpected: index } }),
          );
        }
        for (let index = 0; index < 3; index += 1) {
          yield* Queue.offer(
            harness.stdout,
            line({ type: "message_end", message: { role: "assistant", isError: index } }),
          );
        }
        const delivered = yield* harness.drain;
        const warnings = delivered.flatMap((notification) =>
          notification._tag === "UndecodableEvent" ? [notification.eventType] : [],
        );
        expect(warnings).toEqual(["command_output", "message_end"]);
        expect(eventsOf(delivered).map((event) => event.type)).toEqual([
          "message_end",
          "message_end",
          "message_end",
        ]);
      }),
    ),
  );
});
