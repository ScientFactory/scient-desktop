import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { makeClaudeDescendantPoll } from "./ClaudeAdapterV2.ts";

const processRow = (pid: number, ppid: number, startedSecond: number) => ({
  pid,
  ppid,
  pgid: pid,
  started: `Sun Nov 15 10:00:0${startedSecond} 2026`,
});
type Table = ReadonlyArray<ReturnType<typeof processRow>>;

const UNREADABLE = "Claude processes may still be running: the process table was unreadable";

const exitCleanup = (tables: Array<Table>) => {
  const warnings: unknown[] = [];
  let reads = 0;
  const tracker = makeClaudeDescendantPoll(
    Effect.sync(() => {
      reads++;
      // A failed `ps` reads as no rows.
      return tables.shift() ?? [];
    }),
  ).track(1000);
  const leftovers = Effect.gen(function* () {
    yield* tracker.refresh;
    const fiber = yield* tracker.leftovers.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message, logLevel }) => {
            if (logLevel === "Warn") warnings.push(message);
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
  return { leftovers, warnings, reads: () => reads };
};

const running: Table = [processRow(1000, 10, 0), processRow(1100, 1000, 1)];

it.effect(
  "retries a failed process table read at exit and still stops the job the CLI left",
  () => {
    const cleanup = exitCleanup([running, [], [processRow(1100, 1, 1)]]);
    return Effect.gen(function* () {
      const left = yield* cleanup.leftovers;
      assert.deepStrictEqual(
        left.map((row) => row.pid),
        [1100],
      );
      assert.strictEqual(cleanup.reads(), 3);
      assert.deepStrictEqual(cleanup.warnings, []);
    });
  },
);

it.effect("reports cleanup it could not verify when the process table stays unreadable", () => {
  const cleanup = exitCleanup([running]);
  return Effect.gen(function* () {
    const left = yield* cleanup.leftovers;
    assert.deepStrictEqual(left, []);
    // One read while running, then the exit read and its two retries.
    assert.strictEqual(cleanup.reads(), 4);
    assert.strictEqual(cleanup.warnings.length, 1);
    assert.include(String(cleanup.warnings[0]), UNREADABLE);
  });
});
