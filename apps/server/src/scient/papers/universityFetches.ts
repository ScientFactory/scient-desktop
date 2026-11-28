import type { AccountId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

interface InFlight {
  readonly withdraw: Deferred.Deferred<void>;
  readonly ended: Deferred.Deferred<void>;
}

/** Each university's page loads under way for papers, for the server's life. */
const inFlight = new Map<AccountId, Set<InFlight>>();

/**
 * Runs a paper's page load through a university so a Sign out can stop it: `None` when it was
 * withdrawn before it finished. It always ends before the Sign out goes on.
 */
export const throughUniversity = Effect.fn("Papers.throughUniversity")(function* <A, E, R>(
  accountId: AccountId,
  load: Effect.Effect<A, E, R>,
) {
  const entry: InFlight = {
    withdraw: yield* Deferred.make<void>(),
    ended: yield* Deferred.make<void>(),
  };
  const entries = inFlight.get(accountId) ?? new Set();
  inFlight.set(accountId, entries.add(entry));
  return yield* load.pipe(
    Effect.asSome,
    Effect.raceFirst(Deferred.await(entry.withdraw).pipe(Effect.as(Option.none<A>()))),
    Effect.ensuring(
      Effect.suspend(() => {
        entries.delete(entry);
        if (entries.size === 0) inFlight.delete(accountId);
        return Deferred.succeed(entry.ended, undefined);
      }),
    ),
  );
});

/** Stops every page load under way through these rows, and waits until each has stopped. */
export const withdrawUniversityFetches = Effect.fn("Papers.withdrawUniversityFetches")(function* (
  accountIds: ReadonlyArray<AccountId>,
) {
  const entries = accountIds.flatMap((accountId) => [...(inFlight.get(accountId) ?? [])]);
  yield* Effect.forEach(entries, (entry) => Deferred.succeed(entry.withdraw, undefined), {
    discard: true,
  });
  yield* Effect.forEach(entries, (entry) => Deferred.await(entry.ended), { discard: true });
});
