/**
 * Scient Connect on the desktop's own computer: signed in means on unless turned off here. This
 * server installs and links itself with a token a window lends once; Off, Turn on or another
 * account fence a running attempt before its credentials apply. CLI-linked hosts are left alone.
 */
import {
  type ScientConnectHostAuthorizeInput,
  type ScientConnectHostBlock,
  type ScientConnectHostStatus,
} from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServer from "effect/http/HttpServer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CloudCliState from "../../cloud/CliState.ts";
import * as CloudLink from "../../cloud/CloudLink.ts";
import { hasCloudPublicConfig } from "../../cloud/publicConfig.ts";
import { relayRetryAfterMillis } from "../../cloud/relayResponse.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ServerActivation from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { loopbackUrlHostForAddress } from "../../startupAccess.ts";

/** Present only after the person turned Scient Connect off on this computer. */
export const SCIENT_CONNECT_OFF_SECRET = "scient-connect-off";
const OFF_BYTES = new TextEncoder().encode("off");

/** A lent token is used only while it is this fresh; relay tokens live about a minute. */
const TOKEN_FRESH_FOR = Duration.seconds(30);
const RETRY_FIRST_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = Duration.toMillis(Duration.minutes(5));
/** Repeated sign-in refusals mean the token will not work, not that the relay is busy. */
const MAX_UNAUTHORIZED_ATTEMPTS = 3;

export class ScientConnectHost extends Context.Service<
  ScientConnectHost,
  {
    readonly status: Stream.Stream<ScientConnectHostStatus>;
    /** A window lends a token. Only the desktop app's own session may (`desktop-bootstrap`). */
    readonly authorize: (
      input: ScientConnectHostAuthorizeInput,
    ) => Effect.Effect<ScientConnectHostStatus>;
    readonly turnOff: Effect.Effect<ScientConnectHostStatus>;
    /** Whether the person turned it off here; late links from older paths must not apply. */
    readonly isOff: Effect.Effect<boolean>;
  }
>()("t3/scient/connect/ScientConnectHost") {}

const UNMANAGED: ScientConnectHostStatus = {
  managed: false,
  off: false,
  phase: "idle",
  linkedAccountId: null,
  authorizationRequest: 0,
};

type Failure =
  | { readonly kind: "retry"; readonly reason: string; readonly afterMillis?: number }
  | { readonly kind: "reauthorize"; readonly reason: string }
  | { readonly kind: "block"; readonly block: ScientConnectHostBlock };

const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : "Scient Connect could not be set up.";

/** What to do after a failed attempt: wait and retry, ask for a new token, or wait for the person. */
function classifyFailure(cause: unknown): Failure {
  const tagged = cause as { readonly _tag?: string; readonly reason?: string } | null;
  switch (tagged?._tag) {
    case "RelayClientInstallError": {
      const reason = tagged.reason;
      // A download or a scanner can fail once; a wrong checksum, a policy or an unknown system won't change.
      return reason === "download_failed" ||
        reason === "install_locked" ||
        reason === "validation_failed" ||
        reason === "write_failed"
        ? { kind: "retry", reason: messageOf(cause) }
        : { kind: "block", block: { reason: "install", message: messageOf(cause) } };
    }
    case "RelayRequestError": {
      const relay = cause as {
        readonly rejection: string;
        readonly linkLimit?: number;
        readonly description: string;
      };
      if (relay.linkLimit !== undefined) {
        return { kind: "block", block: { reason: "limit", maxTunnels: relay.linkLimit } };
      }
      if (relay.rejection === "unavailable") {
        const afterMillis = relayRetryAfterMillis(cause);
        return {
          kind: "retry",
          reason: relay.description,
          ...(afterMillis === undefined ? {} : { afterMillis }),
        };
      }
      if (relay.rejection === "unauthorized") {
        return { kind: "reauthorize", reason: relay.description };
      }
      return { kind: "block", block: { reason: "failed", message: relay.description } };
    }
    case "ManagedPolicyRefusedError":
      return { kind: "block", block: { reason: "policy", message: messageOf(cause) } };
    // The tunnel did not start, or the server could not reach its own files for a moment.
    case "CloudLinkEndpointUnavailableError":
    case "SecretStoreError":
    case "PlatformError":
      return { kind: "retry", reason: messageOf(cause) };
    default:
      return { kind: "block", block: { reason: "failed", message: messageOf(cause) } };
  }
}

interface Attempt {
  readonly accountId: string;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void>;
}

interface LentToken {
  readonly accountId: string;
  readonly token: string;
  readonly receivedAt: number;
}

export const make = Effect.fn("ScientConnectHost.make")(function* (options: {
  /** Whether this build has Scient Connect (its public cloud configuration). */
  readonly cloudConfigured: boolean;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const cliOwned = yield* CloudCliState.readCliDesiredCloudLink.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.orElseSucceed(() => false),
  );
  const managed = config.mode === "desktop" && options.cloudConfigured && !cliOwned;
  const statusRef = yield* SubscriptionRef.make<ScientConnectHostStatus>(
    managed ? { ...UNMANAGED, managed: true } : UNMANAGED,
  );
  if (!managed) {
    return ScientConnectHost.of({
      status: SubscriptionRef.changes(statusRef),
      authorize: Effect.fn("ScientConnectHost.authorizeUnmanaged")(function* () {
        return yield* SubscriptionRef.get(statusRef);
      }),
      turnOff: SubscriptionRef.get(statusRef),
      isOff: Effect.succeed(false),
    });
  }

  const cloudLink = yield* CloudLink.CloudLink;
  const relayClient = yield* RelayClient.RelayClient;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const scope = yield* Scope.Scope;
  const attemptsScope = yield* Scope.fork(scope, "sequential");
  const lock = yield* Semaphore.make(1);

  const off = yield* Ref.make(
    yield* secrets.get(SCIENT_CONNECT_OFF_SECRET).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    ),
  );
  const generation = yield* Ref.make(0);
  const attempt = yield* Ref.make<Attempt | null>(null);
  const block = yield* Ref.make<ScientConnectHostBlock | null>(null);
  const lent = yield* Ref.make<LentToken | null>(null);
  /** Completed by the next lent token while an attempt waits for one. */
  const tokenWaiter = yield* Ref.make<Deferred.Deferred<LentToken> | null>(null);
  const localOrigin = yield* Deferred.make<string>();

  const connectDenial = ManagedLimits.allowsConnect(policy)
    ? undefined
    : ManagedLimits.refuseConnect(policy).message;

  const linkedAccount = cloudLink.linkState().pipe(
    Effect.map((state) => ({
      accountId: state.linked ? state.cloudUserId : null,
      connected: state.linked && state.linkRevoked !== true && state.managedTunnelActive === true,
      revoked: state.linkRevoked === true,
    })),
    Effect.orElseSucceed(() => ({ accountId: null, connected: false, revoked: false })),
  );

  const publish = (
    patch: Partial<ScientConnectHostStatus> & Pick<ScientConnectHostStatus, "phase">,
  ) =>
    SubscriptionRef.update(statusRef, (current) => {
      const next: ScientConnectHostStatus = {
        managed: true,
        off: patch.off ?? current.off,
        phase: patch.phase,
        linkedAccountId:
          patch.linkedAccountId === undefined ? current.linkedAccountId : patch.linkedAccountId,
        authorizationRequest: patch.authorizationRequest ?? current.authorizationRequest,
      };
      return {
        ...next,
        ...(patch.installStage ? { installStage: patch.installStage } : {}),
        ...(patch.block ? { block: patch.block } : {}),
        ...(patch.retryReason ? { retryReason: patch.retryReason } : {}),
      };
    });

  /** The status when no attempt is running, from what is stored. */
  const settle = Effect.gen(function* () {
    const linked = yield* linkedAccount;
    const isOff = yield* Ref.get(off);
    const blocked = yield* Ref.get(block);
    if (isOff) return yield* publish({ phase: "idle", off: true, linkedAccountId: null });
    if (connectDenial !== undefined) {
      return yield* publish({
        phase: "blocked",
        off: false,
        linkedAccountId: linked.accountId,
        block: { reason: "policy", message: connectDenial },
      });
    }
    if (blocked !== null) {
      return yield* publish({
        phase: "blocked",
        off: false,
        linkedAccountId: linked.accountId,
        block: blocked,
      });
    }
    if (linked.revoked) {
      return yield* publish({
        phase: "blocked",
        off: false,
        linkedAccountId: linked.accountId,
        block: { reason: "revoked" },
      });
    }
    if (linked.connected) {
      return yield* publish({ phase: "connected", off: false, linkedAccountId: linked.accountId });
    }
    const current = yield* SubscriptionRef.get(statusRef);
    yield* publish({
      phase: "needs-authorization",
      off: false,
      linkedAccountId: linked.accountId,
      authorizationRequest: current.authorizationRequest + 1,
    });
  });

  /** A fresh token for the account, asking the windows for one when the last is too old. */
  const freshToken = Effect.fn("ScientConnectHost.freshToken")(function* (accountId: string) {
    const now = yield* Clock.currentTimeMillis;
    const latest = yield* Ref.getAndSet(lent, null);
    if (
      latest !== null &&
      latest.accountId === accountId &&
      now - latest.receivedAt < Duration.toMillis(TOKEN_FRESH_FOR)
    ) {
      return latest.token;
    }
    const waiter = yield* Deferred.make<LentToken>();
    yield* Ref.set(tokenWaiter, waiter);
    const current = yield* SubscriptionRef.get(statusRef);
    yield* publish({
      phase: "needs-authorization",
      authorizationRequest: current.authorizationRequest + 1,
    });
    // A token for another account ends this attempt first (see authorize), so this one matches.
    const answered = yield* Deferred.await(waiter);
    return answered.token;
  });

  const stopCloudCopy = Option.match(settings, {
    onNone: () => Effect.void,
    onSome: (service) =>
      service.updateSettings({ scientCloudSyncEnabled: false }).pipe(Effect.ignore),
  });

  const runAttempt = Effect.fn("ScientConnectHost.runAttempt")(function* (
    accountId: string,
    ownGeneration: number,
  ) {
    const origin = yield* Deferred.await(localOrigin);
    const stillWanted = Effect.gen(function* () {
      return (yield* Ref.get(generation)) === ownGeneration && !(yield* Ref.get(off));
    });
    let unauthorized = 0;
    let retries = 0;
    while (true) {
      const outcome = yield* Effect.gen(function* () {
        const resolved = yield* relayClient.resolve;
        if (resolved.status !== "available" || !RelayClient.isPinnedManagedRelayClient(resolved)) {
          yield* publish({ phase: "installing", installStage: "checking" });
          yield* relayClient.installWithProgress((event) =>
            event.type === "progress"
              ? publish({ phase: "installing", installStage: event.stage })
              : Effect.void,
          );
        }
        const token = yield* freshToken(accountId);
        const before = yield* linkedAccount;
        yield* publish({ phase: "linking" });
        const result = yield* cloudLink.linkWithAccessToken({
          localOrigin: origin,
          accessToken: token,
          stillWanted,
        });
        // Moving to another account leaves the old one's cloud copy, like unlinking does.
        if (result === "linked" && before.accountId !== null && before.accountId !== accountId) {
          yield* stopCloudCopy;
        }
      }).pipe(Effect.exit);
      if (Exit.isSuccess(outcome)) return;
      const cause = outcome.cause;
      const error = Option.getOrUndefined(Exit.findErrorOption(outcome));
      if (error === undefined) return yield* Effect.failCause(cause);
      const failure = classifyFailure(error);
      yield* Effect.logWarning("Scient Connect setup attempt failed", {
        kind: failure.kind,
        error: messageOf(error),
      });
      if (failure.kind === "block") {
        yield* Ref.set(block, failure.block);
        return;
      }
      if (failure.kind === "reauthorize") {
        unauthorized += 1;
        if (unauthorized >= MAX_UNAUTHORIZED_ATTEMPTS) {
          yield* Ref.set(block, { reason: "failed", message: failure.reason });
          return;
        }
      }
      const backoff = Math.min(RETRY_MAX_DELAY_MS, RETRY_FIRST_DELAY_MS * 2 ** retries);
      const jitter = yield* Random.nextBetween(0.8, 1.2);
      const delay = Math.max(
        Math.round(backoff * jitter),
        failure.kind === "retry" ? (failure.afterMillis ?? 0) : 0,
      );
      retries += 1;
      yield* publish({ phase: "waiting-to-retry", retryReason: failure.reason });
      yield* Effect.sleep(Duration.millis(delay));
      if (!(yield* stillWanted)) return;
    }
  });

  const settleIfIdle = Effect.gen(function* () {
    if ((yield* Ref.get(attempt)) === null) yield* settle;
  });

  const startAttempt = Effect.fn("ScientConnectHost.startAttempt")(function* (accountId: string) {
    const ownGeneration = yield* Ref.updateAndGet(generation, (value) => value + 1);
    // Starts once it is recorded, so its own cleanup always finds it.
    const recorded = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(recorded).pipe(
      Effect.andThen(runAttempt(accountId, ownGeneration)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Scient Connect setup stopped", { cause }).pipe(
              Effect.andThen(Ref.set(block, { reason: "failed", message: messageOf(cause) })),
            ),
      ),
      // Never take the lock here: Off and Turn on interrupt attempts while holding it.
      Effect.ensuring(
        Ref.update(attempt, (current) => (current?.generation === ownGeneration ? null : current)),
      ),
      // Whoever interrupted an attempt publishes what follows; a finished one settles itself.
      Effect.andThen(lock.withPermits(1)(settleIfIdle)),
      Effect.forkIn(attemptsScope),
    );
    const started: Attempt = { accountId, generation: ownGeneration, fiber };
    yield* Ref.set(attempt, started);
    yield* Deferred.succeed(recorded, undefined);
    return started;
  });

  /** Ends the running attempt, if any; its fence rejects anything it had not applied yet. */
  const stopAttempt = Effect.gen(function* () {
    yield* Ref.update(generation, (value) => value + 1);
    const running = yield* Ref.getAndSet(attempt, null);
    yield* Ref.set(tokenWaiter, null);
    if (running !== null) yield* Fiber.interrupt(running.fiber);
  });

  const authorize = Effect.fn("ScientConnectHost.authorize")(function* (
    input: ScientConnectHostAuthorizeInput,
  ) {
    const receivedAt = yield* Clock.currentTimeMillis;
    const started = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (connectDenial !== undefined) {
          yield* settle;
          return null;
        }
        if (input.turnOn) {
          if (yield* Ref.get(off)) {
            yield* secrets.remove(SCIENT_CONNECT_OFF_SECRET).pipe(Effect.ignore);
            yield* Ref.set(off, false);
          }
          yield* Ref.set(block, null);
        }
        if (yield* Ref.get(off)) return null;
        if ((yield* Ref.get(block)) !== null) return null;
        const token: LentToken = {
          accountId: input.accountId,
          token: input.token,
          receivedAt,
        };
        const running = yield* Ref.get(attempt);
        if (running !== null && running.accountId === input.accountId) {
          const waiter = yield* Ref.getAndSet(tokenWaiter, null);
          if (waiter !== null) yield* Deferred.succeed(waiter, token);
          else yield* Ref.set(lent, token);
          return running;
        }
        if (running !== null) yield* stopAttempt;
        const linked = yield* linkedAccount;
        if (linked.revoked && !input.turnOn) {
          yield* settle;
          return null;
        }
        if (linked.connected && linked.accountId === input.accountId) {
          yield* settle;
          return null;
        }
        yield* Ref.set(lent, token);
        return yield* startAttempt(input.accountId);
      }),
    );
    if (started !== null) yield* Fiber.await(started.fiber);
    return yield* SubscriptionRef.get(statusRef);
  });

  const turnOff = lock
    .withPermits(1)(
      Effect.gen(function* () {
        yield* secrets.set(SCIENT_CONNECT_OFF_SECRET, OFF_BYTES).pipe(Effect.ignore);
        yield* Ref.set(off, true);
        yield* Ref.set(block, null);
        yield* stopAttempt;
        const linked = yield* linkedAccount;
        if (linked.accountId !== null) {
          yield* cloudLink.unlink().pipe(
            Effect.andThen(stopCloudCopy),
            Effect.catch((cause) =>
              Effect.logWarning("Could not unlink Scient Connect after it was turned off", {
                cause,
              }),
            ),
          );
        }
        yield* settle;
      }),
    )
    .pipe(Effect.andThen(SubscriptionRef.get(statusRef)));

  // After activation, so a standby server never links: learn this server's address, drop a link
  // left behind by a failed Off, and ask signed-in windows for a token if setup is needed.
  yield* ServerActivation.forkParked(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) return;
      yield* Deferred.succeed(
        localOrigin,
        `http://${loopbackUrlHostForAddress(address)}:${address.port}`,
      );
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(off)) && (yield* linkedAccount).accountId !== null) {
            yield* cloudLink.unlink().pipe(Effect.ignore);
          }
          yield* settleIfIdle;
        }),
      );
    }),
  );

  return ScientConnectHost.of({
    status: SubscriptionRef.changes(statusRef),
    authorize,
    turnOff,
    isOff: Ref.get(off),
  });
});

export const layer = Layer.effect(
  ScientConnectHost,
  Effect.suspend(() => make({ cloudConfigured: hasCloudPublicConfig() })),
);
