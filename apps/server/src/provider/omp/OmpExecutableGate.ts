import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

/**
 * Serializes Oh My Pi runtime mutation against new OMP processes in this
 * server (invariant I5). Every OMP child process holds a lease on its
 * canonical executable identity (the real path of the resolved command) for
 * its whole life: conversations, discovery, text generation, custom-model
 * tests, and managed qualification. A managed-runtime activation takes the
 * identity exclusively: new leases wait behind it, and it waits for short
 * one-shot work to drain. Conversations are expected to have been stopped by
 * the provider runtime manager's activation window before activation starts.
 *
 * The gate is per server. It does not coordinate a second Scient process;
 * Scient never runs `omp update`, so nothing else replaces an executable that
 * Scient launched.
 */

/** How long a new process waits behind an activation before failing. */
export const OMP_PROCESS_WAIT_TIMEOUT = Duration.seconds(30);
/** How long an activation waits for one-shot OMP work to finish. */
export const OMP_ACTIVATION_DRAIN_TIMEOUT = Duration.seconds(30);
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_VERSION_CACHE_ENTRIES = 128;

export type OmpProcessKind = "session" | "one-shot";

export class OmpExecutableBusyError extends Schema.TaggedError<OmpExecutableBusyError>()(
  "OmpExecutableBusyError",
  {
    identity: Schema.String,
    reason: Schema.Literals([
      "updating",
      "activation-pending",
      "conversations-open",
      "work-running",
    ]),
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}

/** Proof of a held activation. Its own qualification process may lease the identity. */
export interface OmpExecutableActivation {
  readonly identity: string;
  readonly token: number;
}

export interface OmpExecutableGateShape {
  /**
   * Lease the executable for one OMP process, released with the scope. Waits
   * while an activation holds the identity, then fails as "being updated".
   */
  readonly acquireProcess: (
    identity: string,
    options: {
      readonly kind: OmpProcessKind;
      /** Admits the activation's own qualification process. */
      readonly activation?: OmpExecutableActivation | undefined;
    },
  ) => Effect.Effect<void, OmpExecutableBusyError, Scope.Scope>;
  /**
   * Hold the executable exclusively until the scope closes. New leases wait;
   * live one-shot leases get a bounded drain; a live conversation fails it.
   */
  readonly acquireActivation: (
    identity: string,
  ) => Effect.Effect<OmpExecutableActivation, OmpExecutableBusyError, Scope.Scope>;
  /** Reuse a successful `--version` verification for an unchanged executable. */
  readonly verifiedVersion: <E, R>(
    key: string,
    verify: Effect.Effect<string, E, R>,
  ) => Effect.Effect<string, E, R>;
}

export class OmpExecutableGate extends Context.Service<OmpExecutableGate, OmpExecutableGateShape>()(
  "t3/provider/omp/OmpExecutableGate",
) {}

interface Activation {
  readonly token: number;
  readonly released: Deferred.Deferred<void>;
  readonly drained: Deferred.Deferred<void>;
}

interface IdentityState {
  readonly leases: ReadonlyMap<number, OmpProcessKind>;
  readonly activation: Activation | undefined;
}

interface GateState {
  readonly nextId: number;
  readonly identities: ReadonlyMap<string, IdentityState>;
}

const EMPTY: IdentityState = { leases: new Map(), activation: undefined };

const withIdentity = (
  state: GateState,
  identity: string,
  next: IdentityState,
): ReadonlyMap<string, IdentityState> => {
  const identities = new Map(state.identities);
  if (next.leases.size === 0 && next.activation === undefined) identities.delete(identity);
  else identities.set(identity, next);
  return identities;
};

const busy = (identity: string, reason: OmpExecutableBusyError["reason"], detail: string) =>
  new OmpExecutableBusyError({ identity, reason, detail });

export const makeOmpExecutableGate = Effect.fn("makeOmpExecutableGate")(function* (options?: {
  readonly processWaitTimeout?: Duration.Input;
  readonly activationDrainTimeout?: Duration.Input;
}) {
  const processWaitTimeout = options?.processWaitTimeout ?? OMP_PROCESS_WAIT_TIMEOUT;
  const drainTimeout = options?.activationDrainTimeout ?? OMP_ACTIVATION_DRAIN_TIMEOUT;
  const state = yield* Ref.make<GateState>({ nextId: 1, identities: new Map() });
  const versions = yield* Ref.make<ReadonlyMap<string, { version: string; expiresAt: number }>>(
    new Map(),
  );

  const releaseLease = (identity: string, id: number) =>
    Ref.modify(state, (current) => {
      const entry = current.identities.get(identity) ?? EMPTY;
      const leases = new Map(entry.leases);
      leases.delete(id);
      const drained = entry.activation && leases.size === 0 ? entry.activation.drained : undefined;
      return [
        drained,
        { ...current, identities: withIdentity(current, identity, { ...entry, leases }) },
      ] as const;
    }).pipe(
      Effect.flatMap((drained) =>
        drained ? Deferred.succeed(drained, undefined).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const releaseActivation = (identity: string, activation: Activation) =>
    Ref.update(state, (current) => {
      const entry = current.identities.get(identity) ?? EMPTY;
      if (entry.activation?.token !== activation.token) return current;
      return {
        ...current,
        identities: withIdentity(current, identity, { ...entry, activation: undefined }),
      };
    }).pipe(Effect.andThen(Deferred.succeed(activation.released, undefined)), Effect.asVoid);

  type LeaseDecision =
    | { readonly _tag: "Leased"; readonly id: number }
    | { readonly _tag: "Wait"; readonly released: Deferred.Deferred<void> };

  const acquireProcess: OmpExecutableGateShape["acquireProcess"] = (identity, leaseOptions) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      // One atomic reservation. Taking the lease and registering its release
      // are uninterruptible together, so an interrupted start cannot leak it.
      const attempt = Effect.uninterruptible(
        Effect.gen(function* () {
          const decision = yield* Ref.modify(
            state,
            (current): readonly [LeaseDecision, GateState] => {
              const entry = current.identities.get(identity) ?? EMPTY;
              const activation = entry.activation;
              if (activation && activation.token !== leaseOptions.activation?.token) {
                return [{ _tag: "Wait", released: activation.released }, current];
              }
              const id = current.nextId;
              const leases = new Map(entry.leases).set(id, leaseOptions.kind);
              return [
                { _tag: "Leased", id },
                {
                  nextId: id + 1,
                  identities: withIdentity(current, identity, { ...entry, leases }),
                },
              ];
            },
          );
          if (decision._tag === "Leased") {
            yield* Scope.addFinalizer(scope, releaseLease(identity, decision.id));
          }
          return decision;
        }),
      );
      const leaseWhenFree: Effect.Effect<void> = attempt.pipe(
        Effect.flatMap((decision) =>
          decision._tag === "Leased"
            ? Effect.void
            : Deferred.await(decision.released).pipe(Effect.andThen(leaseWhenFree)),
        ),
      );
      yield* leaseWhenFree.pipe(
        Effect.timeoutOrElse({
          duration: processWaitTimeout,
          orElse: () =>
            Effect.fail(
              busy(identity, "updating", "Oh My Pi is being updated. Try again in a moment."),
            ),
        }),
      );
    });

  type ActivationDecision =
    | { readonly _tag: "Held"; readonly activation: Activation; readonly draining: boolean }
    | { readonly _tag: "Refused"; readonly error: OmpExecutableBusyError };

  const acquireActivation: OmpExecutableGateShape["acquireActivation"] = (identity) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const released = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const decision = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* Ref.modify(
            state,
            (current): readonly [ActivationDecision, GateState] => {
              const entry = current.identities.get(identity) ?? EMPTY;
              if (entry.activation) {
                return [
                  {
                    _tag: "Refused",
                    error: busy(
                      identity,
                      "activation-pending",
                      "Another Oh My Pi runtime change is already in progress.",
                    ),
                  },
                  current,
                ];
              }
              const conversations = [...entry.leases.values()].filter(
                (kind) => kind === "session",
              ).length;
              if (conversations > 0) {
                return [
                  {
                    _tag: "Refused",
                    error: busy(
                      identity,
                      "conversations-open",
                      `Oh My Pi still has ${conversations} open conversation${conversations === 1 ? "" : "s"}. Stop them and try again.`,
                    ),
                  },
                  current,
                ];
              }
              const activation: Activation = { token: current.nextId, released, drained };
              return [
                { _tag: "Held", activation, draining: entry.leases.size > 0 },
                {
                  nextId: current.nextId + 1,
                  identities: withIdentity(current, identity, { ...entry, activation }),
                },
              ];
            },
          );
          if (result._tag === "Held") {
            yield* Scope.addFinalizer(scope, releaseActivation(identity, result.activation));
          }
          return result;
        }),
      );
      if (decision._tag === "Refused") return yield* decision.error;
      const { activation } = decision;
      if (decision.draining) {
        yield* Deferred.await(drained).pipe(
          Effect.timeoutOrElse({
            duration: drainTimeout,
            orElse: () =>
              Effect.fail(
                busy(
                  identity,
                  "work-running",
                  "Oh My Pi is still finishing background work. Try the runtime change again in a moment.",
                ),
              ),
          }),
          // Release at once: waiting processes must not stall until the
          // caller's scope closes.
          Effect.onError(() => releaseActivation(identity, activation)),
        );
      }
      return { identity, token: activation.token };
    });

  const verifiedVersion: OmpExecutableGateShape["verifiedVersion"] = (key, verify) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(versions)).get(key);
      if (cached && cached.expiresAt > now) return cached.version;
      const version = yield* verify;
      yield* Ref.update(versions, (current) => {
        const next = new Map([...current].filter(([, entry]) => entry.expiresAt > now));
        next.delete(key);
        while (next.size >= MAX_VERSION_CACHE_ENTRIES) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next.set(key, { version, expiresAt: now + VERSION_CACHE_TTL_MS });
      });
      return version;
    });

  return OmpExecutableGate.of({ acquireProcess, acquireActivation, verifiedVersion });
});

export const layer = Layer.effect(OmpExecutableGate, makeOmpExecutableGate());

/**
 * The executable identity: its real path. A path that does not exist yet (a
 * managed runtime before its first activation) keeps the real path of its
 * nearest existing parent, so it matches the identity it will have once
 * installed.
 */
export const canonicalOmpExecutablePath = Effect.fn("canonicalOmpExecutablePath")(function* (
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(executable);
  const canonical = (candidate: string): Effect.Effect<string> =>
    fs.realPath(candidate).pipe(
      Effect.catch(() => {
        const parent = path.dirname(candidate);
        return parent === candidate
          ? Effect.succeed(candidate)
          : canonical(parent).pipe(Effect.map((real) => path.join(real, path.basename(candidate))));
      }),
    );
  return yield* canonical(absolute);
});
