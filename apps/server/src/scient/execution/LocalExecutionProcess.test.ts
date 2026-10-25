// @effect-diagnostics nodeBuiltinImport:off -- integration fixture probes its captured child PID.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionRunId } from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { ExecutionProcess, layer } from "./LocalExecutionProcess.ts";
import {
  descendantFixture,
  processExists,
  successfulParentWithDescendantFixture,
  successfulParentWithResistantDescendantFixture,
} from "./LocalProcessTestSupport.ts";

const Live = layer.pipe(Layer.provideMerge(NodeServices.layer));

/**
 * The production cleanup, with its SIGTERM-to-SIGKILL deadline (5 s) cut to
 * 100 ms so a SIGTERM-resistant descendant is force-stopped quickly. A kill
 * without a deadline is passed through unchanged.
 */
const LiveWithShortKillDeadline = layer.pipe(
  Layer.provide(
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
        ChildProcessSpawner.make((command) =>
          spawner.spawn(command).pipe(
            Effect.map((handle) => ({
              ...handle,
              kill: (options) =>
                handle.kill(
                  options?.forceKillAfter === undefined
                    ? options
                    : { ...options, forceKillAfter: "100 millis" },
                ),
            })),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("LocalExecutionProcess", () => {
  it.effect("finishes short commands without a cancellation grace delay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ExecutionProcess;
        const started = yield* Clock.currentTimeMillis;
        const handle = yield* processes.start({
          runId: ExecutionRunId.make("short-process-test"),
          executable: NodeProcess.execPath,
          args: ["-e", "process.stdout.write('done')"],
          cwd: NodeProcess.cwd(),
          environment: {},
        });
        const output = yield* Effect.forkScoped(Stream.runCollect(handle.output));
        expect(yield* handle.exitCode).toBe(0);
        yield* Fiber.join(output);
        expect(yield* Clock.currentTimeMillis).toBe(started);
      }),
    ).pipe(Effect.provide(Live)),
  );
  it.effect("cancels a spawned descendant with the owned process tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ExecutionProcess;
        const handle = yield* processes.start({
          runId: ExecutionRunId.make("process-tree-test"),
          executable: NodeProcess.execPath,
          args: ["-e", descendantFixture],
          cwd: NodeProcess.cwd(),
          environment: {},
        });
        const childPidLine = yield* handle.output.pipe(
          Stream.filter((output) => output.stream === "stdout"),
          Stream.map((output) => output.text),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const childPid = Number(childPidLine);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(processExists(childPid)).toBe(true);

        yield* handle.cancel;

        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(Live), TestClock.withLive),
  );

  it.effect("cleans up descendants after the direct parent exits successfully", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ExecutionProcess;
        const handle = yield* processes.start({
          runId: ExecutionRunId.make("successful-process-tree-test"),
          executable: NodeProcess.execPath,
          args: ["-e", successfulParentWithDescendantFixture],
          cwd: NodeProcess.cwd(),
          environment: {},
        });
        const childPidLine = yield* handle.output.pipe(
          Stream.filter((output) => output.stream === "stdout"),
          Stream.map((output) => output.text),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const childPid = Number(childPidLine);
        expect(processExists(childPid)).toBe(true);

        expect(yield* handle.exitCode).toBe(0);
        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(Live), TestClock.withLive),
  );

  it.effect("force-stops a resistant descendant after the direct parent exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ExecutionProcess;
        const handle = yield* processes.start({
          runId: ExecutionRunId.make("resistant-successful-process-tree-test"),
          executable: NodeProcess.execPath,
          args: ["-e", successfulParentWithResistantDescendantFixture],
          cwd: NodeProcess.cwd(),
          environment: {},
        });
        const childPid = Number(
          yield* handle.output.pipe(
            Stream.filter((output) => output.stream === "stdout"),
            Stream.map((output) => output.text),
            Stream.splitLines,
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );
        expect(processExists(childPid)).toBe(true);

        expect(yield* handle.exitCode).toBe(0);
        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(LiveWithShortKillDeadline), TestClock.withLive),
  );

  it.effect("cleans up its owned tree when the caller scope closes", () =>
    Effect.gen(function* () {
      let childPid = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const processes = yield* ExecutionProcess;
          const handle = yield* processes.start({
            runId: ExecutionRunId.make("scoped-process-tree-test"),
            executable: NodeProcess.execPath,
            args: ["-e", descendantFixture],
            cwd: NodeProcess.cwd(),
            environment: {},
          });
          childPid = Number(
            yield* handle.output.pipe(
              Stream.filter((output) => output.stream === "stdout"),
              Stream.map((output) => output.text),
              Stream.splitLines,
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          );
          expect(processExists(childPid)).toBe(true);
        }),
      );
      expect(processExists(childPid)).toBe(false);
    }).pipe(Effect.provide(Live), TestClock.withLive),
  );
});
