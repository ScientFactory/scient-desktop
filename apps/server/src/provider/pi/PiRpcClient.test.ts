import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiRpcClient,
  makePiRpcTransport,
  PiRpcCommandError,
  PiRpcProtocolError,
  PiRpcProcessExitedError,
  PiRpcRequestTimeoutError,
} from "./PiRpcClient.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);

const makeIo = Effect.fn("PiRpcClient.test.makeIo")(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const writes = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();
  return {
    stdout,
    writes,
    io: {
      stdout: Stream.fromQueue(stdout).pipe(
        Stream.mapError((cause) => new PiRpcProtocolError({ detail: "test stdout failed", cause })),
      ),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Queue.offer(writes, decoder.decode(chunk)).pipe(Effect.asVoid),
      ),
    },
  } as const;
});

const respondTo = (stdout: Queue.Queue<Uint8Array, Cause.Done<void>>, request: string) => {
  const parsed = JSON.parse(request) as { readonly id: string; readonly type: string };
  return Queue.offer(
    stdout,
    bytes(
      `${JSON.stringify({ type: "response", command: parsed.type, success: true, id: parsed.id })}\n`,
    ),
  );
};

describe("PiRpcClient transport", () => {
  it.effect("correlates 200 overlapping requests returned in reverse order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeIo();
        const client = yield* makePiRpcTransport(test.io);
        const pending = yield* Effect.forEach(Array.from({ length: 200 }), () =>
          client.getState().pipe(Effect.forkScoped),
        );
        const writes = yield* Effect.forEach(pending, () => Queue.take(test.writes));
        for (const write of writes.toReversed()) {
          const command = decodeRequest(write);
          yield* Queue.offer(
            test.stdout,
            bytes(
              `${encodeJson({ type: "response", command: "get_state", id: command.id, success: true, data: { sessionId: command.id } })}\n`,
            ),
          );
        }
        const results = yield* Effect.forEach(pending, Fiber.join);
        expect(results.map((result) => result.sessionId)).toEqual(
          writes.map((write) => decodeRequest(write).id),
        );
      }),
    ),
  );

  it.effect("bounds a blocked stdin write and closes exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeIo();
        const entered = yield* Deferred.make<void>();
        let closes = 0;
        const client = yield* makePiRpcTransport(
          {
            ...test.io,
            stdin: Sink.forEach(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          },
          {
            requestTimeoutMs: 10,
            close: Effect.sync(() => {
              closes++;
            }),
          },
        );
        const pending = yield* client.prompt("test").pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("11 millis");
        expect(yield* Fiber.join(pending)).toBeInstanceOf(PiRpcRequestTimeoutError);
        yield* client.close();
        expect(closes).toBe(1);
      }),
    ),
  );

  it.effect("drains complete frames before EOF and supports consumer fences", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeIo();
        const client = yield* makePiRpcTransport(test.io);
        yield* Queue.offer(
          test.stdout,
          bytes('{"type":"message_end"}\n{"type":"agent_settled"}\n'),
        );
        yield* Queue.end(test.stdout);
        const received = yield* Stream.runCollect(client.events);
        expect(Array.from(received)).toEqual([{ type: "message_end" }, { type: "agent_settled" }]);
      }),
    ),
  );

  it.effect("keeps interactive prompt acknowledgement open beyond query timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeIo();
        const client = yield* makePiRpcTransport(test.io, { requestTimeoutMs: 10 });
        const pending = yield* client.prompt("human input").pipe(Effect.forkScoped);
        const write = yield* Queue.take(test.writes);
        yield* TestClock.adjust("1 minute");
        yield* respondTo(test.stdout, write);
        yield* Fiber.join(pending);
      }),
    ),
  );

  it.effect("frames chunks and preserves unicode line separators", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      yield* Queue.offer(test.stdout, bytes('{"type":"message","text":"a'));
      yield* Queue.offer(test.stdout, bytes('\u2028b\u2029c"}\r\n'));
      const events = yield* Fiber.join(eventFiber);
      expect(Array.from(events)).toEqual([{ type: "message", text: "a\u2028b\u2029c" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces malformed JSON without blocking a correlated response", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      const stateFiber = yield* client.getState().pipe(Effect.forkScoped);
      const request = yield* Queue.take(test.writes);
      expect(request).toContain('"type":"get_state"');
      yield* Queue.offer(test.stdout, bytes("not json\n"));
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-1","data":{"sessionId":"s1"}}\n',
        ),
      );
      const state = yield* Fiber.join(stateFiber);
      expect(state.sessionId).toBe("s1");
      expect(Array.from(yield* Fiber.join(eventsFiber))[0]).toMatchObject({
        _tag: "PiRpcProtocolFailureEvent",
        reason: "MalformedJson",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("decodes extension commands, prompt templates, and skills", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const commandsFiber = yield* client.getCommands().pipe(Effect.forkScoped);
      const request = yield* Queue.take(test.writes);
      expect(request).toContain('"type":"get_commands"');
      expect(request).toContain('"id":"t3-pi-1"');
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_commands","success":true,"id":"t3-pi-1","data":{"commands":[{"name":"skill:review","description":"Review changes","source":"skill","sourceInfo":{"path":"/tmp/review/SKILL.md","source":"auto","scope":"user","origin":"top-level"}}]}}\n',
        ),
      );
      expect(yield* Fiber.join(commandsFiber)).toEqual({
        commands: [
          {
            name: "skill:review",
            description: "Review changes",
            source: "skill",
            sourceInfo: {
              path: "/tmp/review/SKILL.md",
              source: "auto",
              scope: "user",
              origin: "top-level",
            },
          },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("bounds oversized remainders and resumes at the next line", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { maxLineLength: 8 });
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(2))).pipe(
        Effect.forkScoped,
      );
      yield* Queue.offer(test.stdout, bytes("123456789"));
      yield* Queue.offer(test.stdout, bytes('\n{"x":1}\n'));
      expect(Array.from(yield* Fiber.join(eventsFiber))).toEqual([
        expect.objectContaining({ reason: "LineTooLong" }),
        { x: 1 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("accepts fragmented Pi event lines larger than the former production limit", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const eventsFiber = yield* Stream.runCollect(client.events.pipe(Stream.take(1))).pipe(
        Effect.forkScoped,
      );
      const text = "x".repeat(1024 * 1024 + 1);
      const line = `{"type":"message","text":"${text}"}\n`;
      const splitAt = 1024 * 1024 + 1;
      yield* Queue.offer(test.stdout, bytes(line.slice(0, splitAt)));
      yield* Queue.offer(test.stdout, bytes(line.slice(splitAt)));
      expect((yield* Fiber.join(eventsFiber))[0]).toEqual({ type: "message", text });
    }).pipe(Effect.scoped),
  );

  it.effect("reports command failures without poisoning later requests", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      const failedFiber = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":false,"id":"t3-pi-1","error":"no state"}\n',
        ),
      );
      expect(yield* Fiber.join(failedFiber)).toBeInstanceOf(PiRpcCommandError);

      const nextFiber = yield* client.getState().pipe(Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-2","data":{"sessionId":"s2"}}\n',
        ),
      );
      expect((yield* Fiber.join(nextFiber)).sessionId).toBe("s2");
    }).pipe(Effect.scoped),
  );

  it.effect("sends extension UI responses without waiting for an acknowledgement", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);
      yield* client.respondToExtensionUi({ id: "ui-1", confirmed: true });
      expect(yield* Queue.take(test.writes)).toBe(
        '{"type":"extension_ui_response","id":"ui-1","confirmed":true}\n',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("writes sequential and concurrent requests as complete NDJSON lines", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io);

      const first = yield* client.prompt("first").pipe(Effect.forkScoped);
      const firstWrite = yield* Queue.take(test.writes);
      expect(firstWrite.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(firstWrite)).not.toThrow();
      yield* respondTo(test.stdout, firstWrite);
      yield* Fiber.join(first);

      const withImage = yield* client
        .prompt("inspect", [{ type: "image", data: "cG5n", mimeType: "image/png" }], "steer")
        .pipe(Effect.forkScoped);
      const imageWrite = yield* Queue.take(test.writes);
      expect(imageWrite).toContain('"type":"prompt"');
      expect(imageWrite).toContain('"message":"inspect"');
      expect(imageWrite).toContain(
        '"images":[{"type":"image","data":"cG5n","mimeType":"image/png"}]',
      );
      expect(imageWrite).toContain('"streamingBehavior":"steer"');
      yield* respondTo(test.stdout, imageWrite);
      yield* Fiber.join(withImage);

      const concurrent = yield* Effect.all([client.prompt("second"), client.prompt("third")], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      const writes = [yield* Queue.take(test.writes), yield* Queue.take(test.writes)];
      for (const write of writes) {
        expect(write.endsWith("\n")).toBe(true);
        expect(write.split("\n")).toHaveLength(2);
        expect(() => JSON.parse(write)).not.toThrow();
        yield* respondTo(test.stdout, write);
      }
      yield* Fiber.join(concurrent);
      expect(
        writes.map((write) => (JSON.parse(write) as { message: string }).message).sort(),
      ).toEqual(["second", "third"]);
    }).pipe(Effect.scoped),
  );

  it.effect("times out requests and refuses to reuse an ambiguous transport", () =>
    Effect.gen(function* () {
      const test = yield* makeIo();
      const client = yield* makePiRpcTransport(test.io, { requestTimeoutMs: 1 });
      const timedOutFiber = yield* client.getState().pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(test.writes);
      yield* TestClock.adjust("2 millis");
      expect(yield* Fiber.join(timedOutFiber)).toBeInstanceOf(PiRpcRequestTimeoutError);

      yield* Queue.offer(
        test.stdout,
        bytes(
          '{"type":"response","command":"get_state","success":true,"id":"t3-pi-1","data":{"sessionId":"late"}}\n',
        ),
      );
      expect(yield* client.getState().pipe(Effect.flip)).toBeInstanceOf(PiRpcProcessExitedError);
    }).pipe(Effect.scoped),
  );
});

describe("PiRpcClient process", () => {
  it.effect("rejects old or unrelated executables before opening RPC", () =>
    Effect.gen(function* () {
      for (const version of ["0.84.3", "unrelated-cli 2.0.0", "0.84.4-beta.1"]) {
        let spawns = 0;
        const spawner = ChildProcessSpawner.make(() => {
          spawns += 1;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(bytes(version)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const error = yield* makePiRpcClient({ command: "fake-pi" }).pipe(
          Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(PiRpcProtocolError);
        expect(error.detail).toContain("0.84.4 or newer");
        expect(spawns).toBe(1);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("keeps the spawned child stdin open between request streams", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      let spawnOptions: unknown;
      const spawner = ChildProcessSpawner.make((command) => {
        spawnOptions = command.options;
        const version = command._tag === "StandardCommand" && command.args.includes("--version");
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: version ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: version ? Stream.make(bytes("0.84.4\n")) : Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });

      yield* makePiRpcClient({ command: "fake-pi" }).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      expect(spawnOptions).toMatchObject({ stdin: { stream: "pipe", endOnDone: false } });
    }).pipe(Effect.scoped),
  );
});
