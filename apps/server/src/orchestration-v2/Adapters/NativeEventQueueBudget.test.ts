import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  makeNativeEventQueueBudget,
  type NativeEventQueueCharge,
} from "./NativeEventQueueBudget.ts";

it.effect("waits for charged receipt publication before another owner's reclamation", () =>
  Effect.gen(function* () {
    const budget = makeNativeEventQueueBudget({ maxBytes: 100, maxItems: 10, globalFactor: 1 });
    const entered = yield* Deferred.make<void>();
    const publish = yield* Deferred.make<void>();
    const attempted = yield* Deferred.make<void>();
    const stored: NativeEventQueueCharge[] = [];
    const closed: string[] = [];
    const first = budget.open(
      Effect.sync(() => {
        closed.push("first");
      }),
      Effect.sync(() => {
        expect(stored).toHaveLength(1);
        stored[0]!.release();
        return true;
      }),
    );
    const other = budget.open(
      Effect.sync(() => {
        closed.push("other");
      }),
      Effect.succeed(true),
    );
    const retaining = yield* first
      .admit("x".repeat(88), false, 1, (charge) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(publish)),
          Effect.andThen(
            Effect.sync(() => {
              stored.push(charge);
            }),
          ),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const admitting = yield* Deferred.succeed(attempted, undefined).pipe(
      Effect.andThen(other.admit("x".repeat(18), false)),
      Effect.forkChild,
    );
    yield* Deferred.await(attempted);
    expect(closed).toEqual([]);
    yield* Deferred.succeed(publish, undefined);
    expect((yield* Fiber.join(retaining)).admitted).toBe(true);
    const result = yield* Fiber.join(admitting);
    expect(result.admitted).toBe(true);
    expect(closed).toEqual(["first"]);
    expect(budget.usage).toEqual({ bytes: 20, items: 1 });
    first.release();
    other.release();
    result.charge?.release();
    stored[0]!.release();
    expect(budget.usage).toEqual({ bytes: 0, items: 0 });
  }),
);

it.effect("retires transferred debt once across dequeue, release and repeated byte pressure", () =>
  Effect.gen(function* () {
    const budget = makeNativeEventQueueBudget({ maxBytes: 100, maxItems: 10, globalFactor: 4 });
    const charges: NativeEventQueueCharge[][] = [];
    const closed: number[] = [];
    const owners = Array.from({ length: 6 }, (_, index) => {
      const receipts: NativeEventQueueCharge[] = [];
      charges.push(receipts);
      return budget.open(
        Effect.sync(() => {
          closed.push(index);
        }),
        Effect.sync(() => {
          receipts.forEach((charge) => charge.release());
          return true;
        }),
      );
    });
    for (let index = 0; index < 5; index++) {
      const result = yield* owners[index]!.admit("x".repeat(98), false);
      expect(result.admitted).toBe(true); // Exactly 100 encoded bytes is allowed.
      if (result.charge) charges[index]!.push(result.charge);
    }
    expect(closed).toEqual([0]);
    expect(budget.usage).toEqual({ bytes: 400, items: 4 });
    charges[0]!.forEach((charge) => {
      charge.release();
      charge.release();
    });
    owners[0]!.release();
    owners[0]!.release();
    expect(budget.usage).toEqual({ bytes: 400, items: 4 });
    const next = yield* owners[5]!.admit("x".repeat(98), false);
    if (next.charge) charges[5]!.push(next.charge);
    expect(closed).toEqual([0, 1]);
    expect(budget.usage).toEqual({ bytes: 400, items: 4 });
    owners.forEach((owner) => owner.release());
    charges.flat().forEach((charge) => charge.release());
    expect(budget.usage).toEqual({ bytes: 0, items: 0 });
  }),
);

it.effect(
  "preserves exact per-owner byte/item thresholds and selects the item-heavy owner under mixed payloads",
  () =>
    Effect.gen(function* () {
      const budget = makeNativeEventQueueBudget({ maxBytes: 100, maxItems: 10, globalFactor: 4 });
      const closed: number[] = [];
      const receipts: NativeEventQueueCharge[][] = [];
      const owners = Array.from({ length: 5 }, (_, index) => {
        const charges: NativeEventQueueCharge[] = [];
        receipts.push(charges);
        return budget.open(
          Effect.sync(() => {
            closed.push(index);
          }),
          Effect.sync(() => {
            charges.forEach((charge) => charge.release());
            return true;
          }),
        );
      });
      const sizes = [0, 88, 0, 0, 0];
      const items = [10, 1, 10, 10, 8];
      for (let index = 0; index < owners.length; index++) {
        const result = yield* owners[index]!.admit("x".repeat(sizes[index]!), false, items[index]);
        expect(result.admitted).toBe(true);
        if (result.charge) receipts[index]!.push(result.charge);
      }
      const result = yield* owners[4]!.admit("", false, 2);
      expect(result.admitted).toBe(true); // The current owner reaches exactly ten items.
      if (result.charge) receipts[4]!.push(result.charge);
      expect(closed).toEqual([0]); // Not owner 1, which holds by far the largest byte payload.
      expect(owners[1]!.closed).toBe(false);
      expect(budget.usage).toEqual({ bytes: 98, items: 31 });
      const itemOverflow = yield* owners[4]!.admit("", false);
      expect(itemOverflow.admitted).toBe(false);
      expect(closed).toEqual([0, 4]);
      const byteOverflow = yield* owners[1]!.inspect("x".repeat(99));
      expect(byteOverflow.admitted).toBe(false); // 101 encoded bytes exceeds the unchanged cap.
      expect(closed).toEqual([0, 4, 1]);
      owners.forEach((owner) => owner.release());
      receipts.flat().forEach((charge) => {
        charge.release();
        charge.release();
      });
      expect(budget.usage).toEqual({ bytes: 0, items: 0 });
    }),
);
