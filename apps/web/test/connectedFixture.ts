import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

interface OwnedFixtureProcess {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout?: { destroy(): unknown } | null;
  readonly stderr?: { destroy(): unknown } | null;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

interface FixtureRelease {
  readonly exists: () => boolean;
  readonly subscribe: (changed: () => void, failed: (cause: unknown) => void) => () => void;
}

class ConnectedFixtureError extends Schema.TaggedError<ConnectedFixtureError>()(
  "ConnectedFixtureError",
  { message: Schema.String },
) {}

export const acquireFixtureResource = Effect.fn("test.connectedFixture.acquireResource")(function* <
  Resource,
>(acquire: () => Promise<Resource>, release: (resource: Resource) => Effect.Effect<void>) {
  // Promise acquisitions cannot be cancelled. Join them and register ownership
  // atomically so a late resource cannot arrive after its scope has closed.
  return yield* Effect.acquireRelease(Effect.promise(acquire), release);
});

export const stopOwnedFixtureProcess = Effect.fn("test.connectedFixture.stopOwnedProcess")(
  function* (child: OwnedFixtureProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = yield* Deferred.make<void>();
    const onExit = () => {
      Deferred.doneUnsafe(exited, Effect.void);
    };
    // Descendants can retain stdio after leader exit. Only the owned leader's
    // exit receipt settles this wait; the leased runner owns group retirement.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => child.once("exit", onExit)),
      () =>
        Effect.sync(() => child.kill("SIGTERM")).pipe(
          Effect.andThen(
            Deferred.await(exited).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.sync(() => child.kill("SIGKILL")).pipe(
                    Effect.andThen(Deferred.await(exited)),
                  ),
              }),
              Effect.timeoutOrElse({
                duration: "13 seconds",
                orElse: () =>
                  Effect.fail(
                    new ConnectedFixtureError({ message: "Owned fixture leader did not exit" }),
                  ),
              }),
            ),
          ),
        ),
      () =>
        Effect.sync(() => {
          child.off("exit", onExit);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }),
    );
  },
);

export const awaitFixtureRelease = Effect.fn("test.connectedFixture.awaitRelease")(function* (
  release: FixtureRelease,
) {
  const released = yield* Deferred.make<void, ConnectedFixtureError>();
  const recheck = () => {
    if (release.exists()) Deferred.doneUnsafe(released, Effect.void);
  };
  const failure = (cause: unknown) =>
    new ConnectedFixtureError({
      message: cause instanceof Error ? cause.message : String(cause),
    });
  yield* Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        release.subscribe(recheck, (cause) => {
          Deferred.doneUnsafe(released, Effect.fail(failure(cause)));
        }),
      catch: failure,
    }),
    () =>
      Effect.sync(recheck).pipe(
        // Subscribe before rechecking so a release concurrent with setup is not lost.
        Effect.andThen(Deferred.await(released)),
      ),
    (close) => Effect.sync(close),
  );
});
