import * as Effect from "effect/Effect";

/** Seal only the confirmed stopped producer, retaining its receipts for the consumer. */
export const makeStoppedNativeProducer = (input: {
  readonly cancelRequests: () => Effect.Effect<void>;
  readonly publishStopped: () => Effect.Effect<void>;
  readonly sealBudget: () => void;
  readonly end: () => Effect.Effect<void>;
}) => {
  let sealed = false;
  const seal = Effect.gen(function* () {
    if (sealed) return;
    yield* input.cancelRequests();
    yield* input.publishStopped();
    input.sealBudget();
    sealed = true;
    yield* input.end();
  });
  return {
    seal,
    get sealed() {
      return sealed;
    },
  };
};

/** Revalidate the captured owner after asynchronous native payload preparation. */
export const capturedNativeOwnerValidator =
  <Owner, E>(input: {
    readonly owner: Owner | undefined;
    readonly current: () => Owner | undefined;
    readonly matches: (owner: Owner) => boolean;
    readonly refuse: () => Effect.Effect<void, E>;
  }) =>
  () =>
    Effect.suspend(() =>
      input.current() === input.owner && input.owner !== undefined && input.matches(input.owner)
        ? Effect.void
        : input.refuse(),
    );
