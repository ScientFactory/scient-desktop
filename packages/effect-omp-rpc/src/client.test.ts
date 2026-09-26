import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeOmpRpcClient, type OmpRpcNotification } from "./client.ts";
import { OMP_RPC_CHUNK_PAYLOAD_BYTES, OmpNegotiateResult } from "./schema.ts";
import { OmpRpcCommandError, OmpRpcProcessExitedError, OmpRpcProtocolError } from "./errors.ts";

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

const negotiate = (stdout: Queue.Queue<Uint8Array>, stdin: Queue.Queue<string>) =>
  Effect.gen(function* () {
    yield* Queue.offer(stdout, line(readyFrame));
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
        const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
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

  it.effect("rejects an outbound command above the physical frame ceiling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
        });
        yield* negotiate(stdout, stdin);
        const failed = yield* client.prompt({ message: "x".repeat(2_000_000) }).pipe(Effect.flip);
        expect(failed).toBeInstanceOf(OmpRpcProtocolError);
        expect(yield* Queue.size(stdin)).toBe(0);
      }),
    ),
  );

  it.effect("ends the event stream even when transport close fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const stdin = yield* Queue.unbounded<string>();
        const client = yield* makeOmpRpcClient({
          stdout: Stream.fromQueue(stdout),
          write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
          close: Effect.fail(new OmpRpcProcessExitedError({ detail: "close failed" })),
        });
        yield* negotiate(stdout, stdin);
        const state = yield* client.getState().pipe(Effect.forkScoped);
        const request = decodeCommand(yield* Queue.take(stdin));
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
        yield* Fiber.join(state);
        yield* client.close();
        expect(yield* client.events.pipe(Stream.runCollect)).toEqual([]);
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
        expect(() =>
          Schema.decodeUnknownSync(OmpNegotiateResult)({ protocolVersion: 1 }),
        ).toThrow();
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
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProtocolError);
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
        expect(yield* client.ready.pipe(Effect.flip)).toBeInstanceOf(OmpRpcProtocolError);
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
        const request = decodeCommand(yield* Queue.take(stdin));
        yield* Queue.offer(stdout, line({ type: "response", command: "get_state", success: true }));
        expect(yield* Fiber.join(state)).toBeInstanceOf(OmpRpcProcessExitedError);
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
        expect(yield* Fiber.join(failed)).toBeInstanceOf(OmpRpcProtocolError);
        expect(yield* Queue.take(seen)).toBe("ProtocolFailure");
        yield* Queue.offer(stdout, line({ type: "agent_end", isTerminal: true }));
        expect(yield* Queue.size(seen)).toBe(0);
      }),
    ),
  );
});
