/**
 * What Scient shows as Droid's status between full probes.
 *
 * A full probe starts a Droid session (status, models and skills share it;
 * Droid runs SessionStart hooks and, signed out, mints a pairing code), so it
 * runs only on explicit triggers: startup or enable, a settings or binary
 * change, the user's refresh, sign-in completion, and recovery after a failed
 * probe (waiting twice as long after each recovery that fails, up to an hour). The periodic check runs `droid --version` only: it notices a removed,
 * broken or replaced binary and a failed probe, and then runs one full probe.
 * Signed out it never probes: it shows the version that answers now, or that
 * the binary no longer runs, over the last probe's result.
 * It cannot notice sign-in, sign-out or key changes made outside Scient, or
 * new models and skills; the next explicit trigger picks those up.
 *
 * A rejected Factory account found during use (a session start or a turn)
 * shows as signed out until the next probe that succeeds, because Droid's
 * probe accepts an invalid key (verified against Droid 0.228.0 and 0.229.0).
 * This is Droid's own overlay rather than the shared `auth.status`
 * (`requiresReauthentication`) path into `ProviderRegistry`: that path only
 * applies to providers offering an assisted sign-in and clears only after a
 * sign-in or sign-out through it. The case Droid needs most is an invalid
 * `FACTORY_API_KEY`, where Droid offers no sign-in (the key is owned by the
 * environment), so the shared path would drop the failure and could never
 * clear it once the key is fixed.
 *
 * @module DroidProviderStatus
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

const MAX_RECOVERY_BACKOFF_MILLIS = 3_600_000;

/** Shown while Factory's rejection of the account stands. */
function withDroidAccountRejection(
  snapshot: ServerProvider,
  rejection: string | undefined,
): ServerProvider {
  if (rejection === undefined || !snapshot.enabled || !snapshot.installed) return snapshot;
  // With FACTORY_API_KEY the account is the environment's key: there is no
  // sign-in to repeat, so the snapshot keeps saying which kind was rejected.
  const usesApiKey = snapshot.auth.type === "apiKey";
  return {
    ...snapshot,
    status: "warning",
    auth: { status: "unauthenticated", required: true, ...(usesApiKey ? { type: "apiKey" } : {}) },
    message: usesApiKey
      ? `Factory rejected FACTORY_API_KEY: ${rejection}. Correct the key in Droid's environment, then check again.`
      : `Factory rejected Droid's sign-in: ${rejection}. Sign in again.`,
  };
}

const isSignedOut = (snapshot: ServerProvider) =>
  snapshot.status !== "error" && snapshot.auth.status === "unauthenticated";

/** What `droid --version` answers now, when that differs from the last probe of a signed-out Droid. */
function withSignedOutBinary(
  snapshot: ServerProvider,
  binary: Option.Option<string | null> | undefined,
): ServerProvider {
  if (binary === undefined || !isSignedOut(snapshot)) return snapshot;
  if (Option.isSome(binary)) return { ...snapshot, version: binary.value };
  return {
    ...snapshot,
    status: "error",
    version: null,
    auth: { status: "unknown" },
    message:
      "Droid CLI no longer runs (`droid --version` failed). Reinstall it or correct its path, then check again.",
  };
}

export const makeDroidProviderStatus = Effect.fn("makeDroidProviderStatus")(function* (input: {
  /** Managed snapshot whose own periodic refresh is off; `refresh` runs a full probe. */
  readonly provider: ManagedServerProvider;
  /** `droid --version`: none when the command failed or timed out. */
  readonly probeVersion: Effect.Effect<Option.Option<string | null>>;
  readonly refreshInterval: Effect.Effect<Duration.Input>;
  readonly hasDemand: Effect.Effect<boolean>;
}): Effect.fn.Return<
  {
    readonly provider: ManagedServerProvider;
    readonly reportAccountRejected: (message: string) => Effect.Effect<void>;
    /** Call with each full probe's result; a successful probe clears a rejection. */
    readonly observeProbe: (snapshot: ServerProvider) => Effect.Effect<void>;
  },
  never,
  Scope.Scope
> {
  const rejectionRef = yield* Ref.make<string | undefined>(undefined);
  const signedOutBinaryRef = yield* Ref.make<Option.Option<string | null> | undefined>(undefined);
  const overlayChanges = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const overlaid = (snapshot: ServerProvider) =>
    Effect.all([Ref.get(signedOutBinaryRef), Ref.get(rejectionRef)]).pipe(
      Effect.map(([binary, rejection]) =>
        withDroidAccountRejection(withSignedOutBinary(snapshot, binary), rejection),
      ),
    );
  const getSnapshot = input.provider.getSnapshot.pipe(Effect.flatMap(overlaid));

  const reportAccountRejected = (message: string) =>
    Ref.set(rejectionRef, message).pipe(
      Effect.andThen(PubSub.publish(overlayChanges, undefined)),
      Effect.asVoid,
    );
  // A probe has looked at the binary itself.
  const observeProbe = (snapshot: ServerProvider) =>
    Ref.set(signedOutBinaryRef, undefined).pipe(
      Effect.andThen(
        snapshot.status === "ready" && snapshot.auth.status === "authenticated"
          ? Ref.set(rejectionRef, undefined)
          : Effect.void,
      ),
    );

  // A failed probe may keep failing after Droid created its session (e.g. a
  // slow SessionStart hook): each recovery attempt doubles the wait, up to an hour.
  let failedRecoveries = 0;
  let nextRecoveryAtMillis = 0;
  const binaryChanged = (current: ServerProvider) =>
    input.probeVersion.pipe(
      Effect.map((version) => Option.isNone(version) || version.value !== current.version),
    );

  const tick = (intervalMillis: number) =>
    Effect.gen(function* () {
      if (!(yield* input.hasDemand)) return;
      const current = yield* input.provider.getSnapshot;
      // A probe is already due or running (startup, settings change, refresh).
      if (!current.enabled || current.probePending === true) return;
      if (current.status !== "error") {
        failedRecoveries = 0;
        nextRecoveryAtMillis = 0;
      }
      if (isSignedOut(current)) {
        // A probe would only mint another pairing code. The version check says
        // on its own whether there is still a Droid to sign in to.
        const version = yield* input.probeVersion;
        const binary =
          Option.isSome(version) && version.value === current.version ? undefined : version;
        if (Equal.equals(yield* Ref.get(signedOutBinaryRef), binary)) return;
        yield* Ref.set(signedOutBinaryRef, binary);
        yield* PubSub.publish(overlayChanges, undefined);
        return;
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const recoveryDue = current.status === "error" && nowMillis >= nextRecoveryAtMillis;
      if (!recoveryDue && !(yield* binaryChanged(current))) return;
      const probed = yield* input.provider.refresh;
      if (probed.status === "error") {
        failedRecoveries += 1;
        nextRecoveryAtMillis =
          nowMillis + Math.min(intervalMillis * 2 ** failedRecoveries, MAX_RECOVERY_BACKOFF_MILLIS);
      }
    });

  yield* Effect.forever(
    input.refreshInterval.pipe(
      Effect.flatMap((interval) => {
        const millis = Duration.toMillis(Duration.fromInputUnsafe(interval));
        // A zero interval turns periodic checks off; look at the setting again later.
        return millis <= 0
          ? Effect.sleep("60 seconds")
          : Effect.sleep(interval).pipe(Effect.andThen(tick(millis)));
      }),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  return {
    reportAccountRejected,
    observeProbe,
    provider: {
      resolveMaintenance: input.provider.resolveMaintenance,
      applyUsageLimits: input.provider.applyUsageLimits,
      getSnapshot,
      refresh: input.provider.refresh.pipe(Effect.flatMap(overlaid)),
      get streamChanges() {
        return Stream.merge(
          input.provider.streamChanges.pipe(Stream.mapEffect(overlaid)),
          Stream.fromPubSub(overlayChanges).pipe(Stream.mapEffect(() => getSnapshot)),
        );
      },
    },
  };
});
