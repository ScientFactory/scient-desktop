import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { classifyTurnDispatchFailure } from "../../provider/turnDispatchPhase.ts";
import { withForkSendDeadline } from "./deliveryDeadline.ts";

it.effect("interrupts a stalled send and keeps its delivery uncertain", () =>
  Effect.gen(function* () {
    let released = false;
    const waiting = yield* withForkSendDeadline(
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
      ),
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("60 seconds");
    const error = yield* Fiber.join(waiting);
    assert.isTrue(released);
    assert.strictEqual(classifyTurnDispatchFailure(Cause.fail(error)), "maybeDelivered");
  }),
);
