import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

it.effect(
  "captures retained clean text without completing it and appends the later suffix once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emitted = yield* Ref.make<ProviderTextDeltaUpdate[]>([]);
        const coalescer = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: 50,
          emit: (update) => Ref.update(emitted, (values) => [...values, update]),
        });
        yield* coalescer.append({ turnId: "root", itemId: "answer", delta: "prefix " });
        yield* coalescer.append({ turnId: "peer", itemId: "answer", delta: "peer " });
        yield* TestClock.adjust("50 millis");
        const capture = yield* coalescer.withSnapshot("root", Effect.succeed);
        assert.deepEqual(capture.items, [
          { turnId: "root", itemId: "answer", text: "prefix ", completed: false },
        ]);
        assert.lengthOf(yield* Ref.get(emitted), 2);
        assert.isTrue(
          Option.isSome(
            yield* coalescer.withWatermark("root", capture.watermark, Effect.succeed("current")),
          ),
        );
        yield* coalescer.append({ turnId: "root", itemId: "answer", delta: "suffix" });
        assert.isTrue(
          Option.isNone(
            yield* coalescer.withWatermark("root", capture.watermark, Effect.succeed("stale")),
          ),
        );
        assert.equal(
          yield* coalescer.complete({ turnId: "root", itemId: "answer" }),
          "prefix suffix",
        );
        assert.deepEqual(
          (yield* Ref.get(emitted)).filter((update) => update.completed),
          [{ turnId: "root", itemId: "answer", text: "prefix suffix", completed: true }],
        );
        assert.equal(
          (yield* coalescer.withSnapshot("peer", Effect.succeed)).items[0]?.text,
          "peer ",
        );
        assert.isEmpty((yield* coalescer.withSnapshot("root", Effect.succeed)).items);
      }),
    ),
);

it.effect(
  "refused or cancelled capture preserves dirty text and releases the existing flush permit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emitted = yield* Ref.make<ProviderTextDeltaUpdate[]>([]);
        const coalescer = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: 50,
          emit: (update) => Ref.update(emitted, (values) => [...values, update]),
        });
        yield* coalescer.append({ turnId: "root", itemId: "answer", delta: "held" });
        const refused = yield* coalescer
          .withSnapshot("root", () => Effect.fail("refused"))
          .pipe(Effect.exit);
        assert.equal(refused._tag, "Failure");
        const cancelled = yield* coalescer
          .withSnapshot("root", () => Effect.never)
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelled);
        yield* TestClock.adjust("50 millis");
        assert.deepEqual(yield* Ref.get(emitted), [
          { turnId: "root", itemId: "answer", text: "held", completed: false },
        ]);
        const captured = yield* coalescer.withSnapshot("root", Effect.succeed);
        yield* coalescer.complete({ turnId: "root", itemId: "answer", finalText: "replacement" });
        assert.isTrue(
          Option.isNone(
            yield* coalescer.withWatermark("root", captured.watermark, Effect.succeed("stale")),
          ),
        );
        assert.equal((yield* Ref.get(emitted)).at(-1)?.text, "replacement");
      }),
    ),
);
