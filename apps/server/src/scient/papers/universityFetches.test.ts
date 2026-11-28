import { AccountId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { throughUniversity, withdrawUniversityFetches } from "./universityFetches.ts";

it.effect("a Sign out stops a page load through its university, and waits until it has", () =>
  Effect.gen(function* () {
    const accountId = AccountId.make("acc_loading_univ1");
    let stopped = false;
    const loading = yield* throughUniversity(
      accountId,
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (stopped = true)))),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* withdrawUniversityFetches([accountId]);
    // The load had stopped before the Sign out went on.
    expect(stopped).toBe(true);
    expect(yield* Fiber.join(loading)).toEqual(Option.none());
    // Another university's loads go on.
    const other = yield* throughUniversity(AccountId.make("acc_other_univ01"), Effect.succeed(1));
    expect(other).toEqual(Option.some(1));
  }),
);
