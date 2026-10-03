import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ScientLiveTurnFlush,
  ScientLiveTurnFlushError,
  ScientLiveTurnFlushLive,
} from "./liveTurnFlush.ts";

it.effect("a timed-out barrier fails instead of claiming successful capture", () =>
  Effect.gen(function* () {
    const flush = yield* ScientLiveTurnFlush;
    yield* flush.register(() => Effect.never);
    const waiting = yield* flush
      .flush(ThreadId.make("fork-source"))
      .pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual((yield* Fiber.join(waiting))._tag, "Failure");
  }).pipe(Effect.provide(ScientLiveTurnFlushLive)),
);

it.effect("an unavailable or failed ingestion worker fails capture", () =>
  Effect.gen(function* () {
    const flush = yield* ScientLiveTurnFlush;
    assert.strictEqual(
      (yield* Effect.result(flush.flush(ThreadId.make("fork-source"))))._tag,
      "Failure",
    );
    yield* flush.register(() =>
      Effect.fail(new ScientLiveTurnFlushError({ detail: "disk failure" })),
    );
    const error = yield* Effect.flip(flush.flush(ThreadId.make("fork-source")));
    assert.strictEqual(error.detail, "disk failure");
  }).pipe(Effect.provide(ScientLiveTurnFlushLive)),
);
