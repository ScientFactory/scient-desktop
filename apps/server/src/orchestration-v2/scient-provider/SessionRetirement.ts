import * as Cause from "effect/Cause";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import {
  ProviderAdapterInterruptError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2InterruptInput,
} from "../ProviderAdapter.ts";

type PumpOwner = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly eventPump: {
    readonly fiber: Fiber.Fiber<void, never> | undefined;
    readonly ended: boolean;
  };
  readonly eventConsumer?: { readonly dispose: Effect.Effect<void> };
};

export const disposeRetiredEventConsumer = (entry: PumpOwner) =>
  Effect.gen(function* () {
    if (!entry.eventConsumer) return;
    if (entry.eventPump.fiber && !entry.eventPump.ended) entry.eventPump.fiber.interruptUnsafe();
    yield* entry.eventConsumer.dispose;
  });

/** Join this exact sealed pump only after native interruption has released its permits. */
export const interruptAndJoinRetirement = <E, R>(input: {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly request: ProviderAdapterV2InterruptInput;
  readonly readEntry: Effect.Effect<PumpOwner | undefined>;
  readonly closeTimeoutMs: number;
  readonly joinRetainedClose: () => Effect.Effect<void, E, R>;
}) =>
  Effect.gen(function* () {
    const entry = yield* input.readEntry;
    yield* input.runtime.interruptTurn(input.request);
    if (input.runtime.providerSession.status !== "stopped") return;
    yield* Effect.gen(function* () {
      if (entry?.runtime === input.runtime && entry.eventPump.fiber)
        yield* Fiber.join(entry.eventPump.fiber).pipe(Effect.timeout(input.closeTimeoutMs));
      yield* input.joinRetainedClose();
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterInterruptError({
            driver: input.runtime.driver,
            providerThreadId: input.request.providerThread.id,
            providerTurnId: input.request.providerTurnId,
            cause,
          }),
      ),
    );
  });

/** Opening snapshots cannot make a known-unusable live owner eligible for reuse. */
export const retireUnusableOwner = <E, R>(
  runtime: ProviderAdapterV2SessionRuntime,
  retire: (reason: "runtime_error" | "manual_shutdown") => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const status = runtime.providerSession.status;
    if (status !== "error" && status !== "stopped") return false;
    yield* retire(status === "error" ? "runtime_error" : "manual_shutdown");
    return true;
  });

/** Keep physical ownership pending even when logical authority retires on timeout. */
export const makeSessionRetirement = <
  Entry extends PumpOwner & {
    readonly scope: Scope.Closeable;
    readonly idleFiber: Fiber.Fiber<void, never> | null;
    readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
    readonly requestEventPermit: Semaphore.Semaphore;
  },
  Input extends {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: string;
    readonly cancelIdleFiber?: boolean;
    readonly gracefulSubscribers?: boolean;
    readonly detail?: string;
  },
  E,
>(steps: {
  readonly closeTimeoutMs: number;
  readonly reclaimCredential: (threadId: ThreadId, credentialId: string) => Effect.Effect<void, E>;
  readonly closeScope: (scope: Scope.Closeable) => Effect.Effect<void, E>;
  readonly cancelIdle: (fiber: Fiber.Fiber<void, never> | null) => Effect.Effect<void, E>;
  readonly endSubscribers: (entry: Entry) => Effect.Effect<void, E>;
  readonly closeSubscribers: (entry: Entry) => Effect.Effect<void, E>;
  readonly failSubscribers: (entry: Entry, detail: string) => Effect.Effect<void, E>;
  readonly releaseConsumer: (entry: Entry) => Effect.Effect<void, E>;
  readonly writeSession: (entry: Entry, input: Input) => Effect.Effect<void, E>;
  readonly writeRequests: (entry: Entry, input: Input) => Effect.Effect<void, E>;
}) =>
  Effect.fnUntraced(function* (entry: Entry, input: Input) {
    const retireCredentials = Effect.forEach(
      entry.mcpCredentialIdByThread,
      ([threadId, credentialId]) => steps.reclaimCredential(threadId, credentialId),
      { discard: true },
    );
    // Physical cleanup starts before any idle/subscriber join can park it.
    const physicalClose = yield* steps
      .closeScope(entry.scope)
      .pipe(Effect.exit, Effect.forkDetach({ startImmediately: true }));
    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.gen(function* () {
          if (input.cancelIdleFiber !== false) yield* steps.cancelIdle(entry.idleFiber);
          if (input.gracefulSubscribers === true) yield* steps.endSubscribers(entry);
          else if (input.reason === "server_shutdown") yield* steps.closeSubscribers(entry);
          else
            yield* steps.failSubscribers(
              entry,
              input.detail ?? `Provider session released: ${input.reason}.`,
            );
          const observed = yield* Fiber.join(physicalClose).pipe(
            Effect.timeoutOption(steps.closeTimeoutMs),
          );
          if (Option.isNone(observed))
            yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
              providerSessionId: input.providerSessionId,
              reason: input.reason,
              timeoutMs: steps.closeTimeoutMs,
            });
          yield* steps.releaseConsumer(entry);
          yield* retireCredentials;
          yield* Effect.all(
            [
              Effect.exit(steps.writeSession(entry, input)),
              Effect.exit(
                steps.writeRequests(entry, input).pipe(entry.requestEventPermit.withPermits(1)),
              ),
            ],
            { concurrency: 1 },
          ).pipe(
            Effect.flatMap((exits) => {
              const failures = exits.filter(Exit.isFailure);
              return failures.length === 0
                ? Effect.void
                : Effect.failCause(
                    failures
                      .slice(1)
                      .reduce(
                        (combined, exit) => Cause.combine(combined, exit.cause),
                        failures[0]!.cause,
                      ),
                  );
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("orchestration-v2.provider-session-release-records-failed", {
                    providerSessionId: input.providerSessionId,
                    cause,
                  }).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
            Effect.retry({
              schedule: Schedule.exponential("1 second").pipe(
                Schedule.modifyDelay(({ duration }) =>
                  Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                ),
              ),
            }),
            Effect.orDie,
          );
          // A timeout retires logical authority; this same physical close remains owned.
          const result = Option.isSome(observed)
            ? observed.value
            : yield* Fiber.join(physicalClose);
          if (Option.isNone(observed))
            yield* Effect.logInfo("orchestration-v2.provider-session-scope-close-finished-late", {
              providerSessionId: input.providerSessionId,
              reason: input.reason,
              outcome: result._tag,
            });
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        }),
      () =>
        Effect.gen(function* () {
          yield* steps.releaseConsumer(entry);
          // Credential revocation is not confirmation that the process exited.
          yield* retireCredentials;
        }),
    );
  });
