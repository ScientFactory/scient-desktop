// @effect-diagnostics globalDate:off -- Delivery times are UI labels; decisions use revisions.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ACCOUNTS_PROTOCOL,
  AuthSettingsWriteScope,
  BrowserProfileId,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountsSnapshot,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import { shareable } from "@t3tools/shared/scientSessionCookies";
import { deliverOnce, DeliveryStopped } from "@t3tools/shared/scientSessionDelivery";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "~/connection/desktopLocal";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironment, readPrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "~/state/session";

import { accountsState } from "./accountsState";

export type RouteRefusal = "relay" | "unencrypted";

/**
 * Sign-ins go only over the environment's own socket on a route that is encrypted or stays on
 * this computer: an SSH tunnel's local end, TLS, a Tailscale name, loopback, or this desktop's WSL.
 */
export function allowedRoute(
  connection: Pick<PreparedConnection, "environmentId" | "socketUrl" | "target">,
  localBackends: ReadonlyArray<Pick<DesktopEnvironmentBootstrap, "id" | "httpBaseUrl">>,
): RouteRefusal | undefined {
  const url = URL.parse(connection.socketUrl);
  if (!url) return "unencrypted";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  switch (connection.target._tag) {
    case "RelayConnectionTarget":
      return "relay";
    case "PrimaryConnectionTarget":
      return "unencrypted";
    case "SshConnectionTarget":
      return url.protocol === "ws:" && isLocalLoopbackHost(host) ? undefined : "unencrypted";
    case "BearerConnectionTarget": {
      const local = localBackends.find((backend) => backend.id === connection.environmentId);
      if (local) {
        const backend = local.httpBaseUrl ? URL.parse(local.httpBaseUrl) : null;
        return backend && backend.hostname === url.hostname && backend.port === url.port
          ? undefined
          : "unencrypted";
      }
      if (url.protocol === "wss:") return undefined;
      return url.protocol === "ws:" && (isLocalLoopbackHost(host) || isTailnetHost(host))
        ? undefined
        : "unencrypted";
    }
  }
}

/** Why a delivery failed, in words safe to show: never a cookie, a key or a server's message. */
export type DeliveryFailureReason = "refused" | "failed";

/** A request of the delivery that the remote or this desktop answered with an error. */
class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  reason: Schema.Literals(["refused", "failed"]),
}) {}
const isDeliveryFailed = Schema.is(DeliveryFailed);
const isDeliveryStopped = Schema.is(DeliveryStopped);

const failureReason = (result: { readonly _tag: string; readonly cause?: unknown }) => {
  const error = Cause.isCause(result.cause) ? Cause.squash(result.cause) : result.cause;
  return typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "denied"
    ? ("refused" as const)
    : ("failed" as const);
};

const recordOf = (snapshot: AccountsSnapshot | undefined, profileId: string) =>
  snapshot?.profiles.find((record) => record.profileId === profileId) ??
  defaultBrowserProfileRecord(profileId);

const value = <A>(result: AsyncResult.AsyncResult<A, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : undefined;

const call = async <I, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> => {
  const result = await command.run(registry, { environmentId, input });
  if (result._tag !== "Success") throw new DeliveryFailed({ reason: failureReason(result) });
  return result.value;
};

const desktopLabel = (primaryId: EnvironmentId) =>
  readEnvironment(primaryId)?.serverConfig?.environment.label ?? "this computer";

/**
 * The key the remote issued this desktop, kept encrypted with this desktop's Accounts. Without
 * one, the remote issues a new key, once; a remote that already knows another key refuses.
 */
async function bindSender(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  primaryId: EnvironmentId,
) {
  const kept = await call(registry, accountsState.senderKey, primaryId, { environmentId });
  const bound = await call(registry, accountsState.sessionsBind, environmentId, {
    source: primaryId,
    label: desktopLabel(primaryId),
    ...(kept.key ? { key: kept.key } : {}),
  });
  if (bound.key)
    await call(registry, accountsState.keepSenderKey, primaryId, { environmentId, key: bound.key });
  const key = bound.key ?? kept.key;
  if (!key) throw new DeliveryStopped({ message: "unbound" });
  return key;
}

/** The last delivery to each remote that failed, until one succeeds. */
export interface DeliveryFailure {
  readonly reason: DeliveryFailureReason;
  readonly at: string;
}

export const deliveryFailuresAtom = Atom.make(
  new Map<EnvironmentId, DeliveryFailure>() as ReadonlyMap<EnvironmentId, DeliveryFailure>,
).pipe(Atom.keepAlive);

/** Waits before each retry of a failed delivery; past the last, the next change tries again. */
const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;

/** Remotes being sent sign-ins now, for "sending your sign-ins…". */
export const sendingRemotesAtom = Atom.make(
  new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>,
).pipe(Atom.keepAlive);

/** Where delivery to a remote stands: what would stop it, or the identity it plans with. */
function routeOf(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const presentation = registry.get(environmentPresentations.presentationAtom(environmentId));
  if (!presentation?.entry.enabled) return { stopped: "removed" } as const;
  if (presentation.connection.phase !== "connected") return { stopped: "offline" } as const;
  const connection = readPreparedConnection(environmentId);
  if (!connection) return { stopped: "offline" } as const;
  const refused = allowedRoute(connection, readDesktopSecondaryBootstraps());
  if (refused) return { stopped: refused } as const;
  if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope))
    return { stopped: "permission" } as const;
  const remote = value(registry.get(accountsState.snapshot({ environmentId, input: {} })));
  if ((remote?.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL)
    return { stopped: "no-feature" } as const;
  const target = connection.target;
  return {
    identity: JSON.stringify([
      target._tag,
      "connectionId" in target ? target.connectionId : null,
      connection.socketUrl,
    ]),
    label: presentation.entry.target.label,
  } as const;
}

const persistentProfiles = () =>
  resolveBrowserProfiles(getClientSettings().browserProfiles).filter(
    (profile) => profile.kind === "persistent",
  );

/**
 * Delivers this desktop's sign-ins to one remote, serially: a nudge while a run goes sets "run
 * again". Each run recomputes from durable state, so a missed nudge only delays delivery. A route,
 * destination or permission change interrupts the run; it sends nothing more.
 */
export function watchRemoteSessions(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  primaryId: EnvironmentId,
) {
  const readSessions = window.desktopBridge?.accounts?.readSessions;
  if (!readSessions) return () => undefined;
  const desktopAtom = accountsState.snapshot({ environmentId: primaryId, input: {} });
  const remoteAtom = accountsState.snapshot({ environmentId, input: {} });
  let stopped = false;
  let running: { readonly identity: string; cancelled: boolean } | undefined;
  let again = false;
  let lastKey: string | undefined;
  let retries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const setSending = (sending: boolean) => {
    const current = new Set(registry.get(sendingRemotesAtom));
    if (sending) current.add(environmentId);
    else current.delete(environmentId);
    registry.set(sendingRemotesAtom, current);
  };

  const setFailure = (failure: DeliveryFailure | undefined) => {
    const current = new Map(registry.get(deliveryFailuresAtom));
    if (failure) current.set(environmentId, failure);
    else if (!current.delete(environmentId)) return;
    registry.set(deliveryFailuresAtom, current);
  };

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    again = false;
    const route = routeOf(registry, environmentId);
    if (stopped || "stopped" in route) return;
    const token = { identity: route.identity, cancelled: false };
    running = token;
    setSending(true);
    const desktop = () => value(registry.get(desktopAtom));
    const outcome = await deliverOnce({
      source: primaryId,
      label: readEnvironment(primaryId)?.serverConfig?.environment.label ?? "this computer",
      remoteId: environmentId,
      remoteLabel: route.label,
      profiles: () =>
        persistentProfiles().map(({ id }) => ({
          profileId: id,
          record: recordOf(desktop(), id),
        })),
      desktopAccounts: () => desktop()?.accounts ?? [],
      signingIn: (profileId) => {
        const snapshot = desktop();
        const accounts = new Set((snapshot?.attempts ?? []).map(({ accountId }) => accountId));
        return (snapshot?.accounts ?? []).flatMap((row) =>
          accounts.has(row.accountId) &&
          row.details.kind === "website" &&
          row.details.profileId === profileId
            ? row.details.sites
            : [],
        );
      },
      revalidate: () => {
        if (token.cancelled || stopped) return "cancelled";
        const now = routeOf(registry, environmentId);
        return "stopped" in now
          ? now.stopped
          : now.identity === token.identity
            ? undefined
            : "route";
      },
      sendLog: (profileId) =>
        call(registry, accountsState.profileSendLog, primaryId, {
          profileId: BrowserProfileId.make(profileId),
        }),
      bind: () => bindSender(registry, environmentId, primaryId),
      applied: (profileId, key) =>
        call(registry, accountsState.sessionsApplied, environmentId, {
          source: primaryId,
          key,
          profileId: BrowserProfileId.make(profileId),
        }),
      remoteRecord: (profileId) =>
        value(registry.get(remoteAtom))?.profiles.find((record) => record.profileId === profileId),
      receive: (input) => call(registry, accountsState.sessionsReceive, environmentId, input),
      withdraw: (profileId, revision, key) =>
        call(registry, accountsState.sessionsWithdraw, environmentId, {
          source: primaryId,
          key,
          profileId: BrowserProfileId.make(profileId),
          revision,
        }).then(() => undefined),
      resend: (profileId) =>
        call(registry, accountsState.profileResend, primaryId, {
          profileId: BrowserProfileId.make(profileId),
          why: "send-again",
        }).then(() => undefined),
      shared: (profileId, share) =>
        call(registry, accountsState.profileShared, primaryId, {
          profileId: BrowserProfileId.make(profileId),
          share,
        }).then(() => undefined),
      readSessions,
      now: () => new Date().toISOString(),
    }).then(
      () => "delivered" as const,
      // A changed route, permission or control stops a run; that is no failure.
      (cause: unknown) =>
        isDeliveryStopped(cause)
          ? ("stopped" as const)
          : isDeliveryFailed(cause)
            ? cause.reason
            : ("failed" as const),
    );
    running = undefined;
    setSending(false);
    if (outcome === "delivered") {
      retries = 0;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      setFailure(undefined);
    } else if (outcome !== "stopped" && !stopped) {
      setFailure({ reason: outcome, at: new Date().toISOString() });
      const wait = RETRY_MS[retries];
      if (wait !== undefined && retry === undefined) {
        retries += 1;
        retry = setTimeout(() => {
          retry = undefined;
          // The same state as the failed run: forget it, so it runs again.
          lastKey = undefined;
          nudge();
        }, wait);
      }
    }
    if (again && !stopped) return run();
  };

  /** What a run depends on; a change nudges, and a route change interrupts the running one. */
  const nudge = () => {
    const route = routeOf(registry, environmentId);
    if (running && ("stopped" in route || route.identity !== running.identity))
      running.cancelled = true;
    if ("stopped" in route) {
      lastKey = undefined;
      return;
    }
    const desktop = value(registry.get(desktopAtom));
    const remote = value(registry.get(remoteAtom));
    const key = JSON.stringify([
      route.identity,
      // A unit held for a sign-in goes once that sign-in ends.
      (desktop?.attempts ?? []).map(({ attemptId }) => attemptId),
      persistentProfiles().map(({ id }) => {
        const record = recordOf(desktop, id);
        return [id, record.send?.head ?? 0, record.access, record.scope, record.scriptSignIn];
      }),
      (remote?.profiles ?? []).map((record) =>
        record.received
          ?.filter((entry) => entry.source === primaryId)
          .map((entry) => [
            entry.withdrawn,
            entry.units.map((unit) => [unit.revision, unit.outcome, unit.needsYou]),
          ]),
      ),
    ]);
    if (key === lastKey) return;
    lastKey = key;
    void run();
  };

  const stops = [
    registry.subscribe(desktopAtom, nudge),
    registry.subscribe(remoteAtom, nudge),
    registry.subscribe(environmentPresentations.presentationAtom(environmentId), nudge),
    registry.subscribe(environmentSession.sessionStateAtom(environmentId), nudge),
    // The persistent profiles it delivers are client settings, part of the key above.
    subscribeClientSettings(nudge),
  ];
  nudge();
  return () => {
    stopped = true;
    if (running) running.cancelled = true;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    for (const stop of stops) stop();
  };
}

/** Send again: every shareable profile's whole jar goes to every remote with the next delivery. */
export async function sendAgain(registry: AtomRegistry.AtomRegistry, primaryId: EnvironmentId) {
  const desktop = value(
    registry.get(accountsState.snapshot({ environmentId: primaryId, input: {} })),
  );
  for (const { id } of persistentProfiles())
    if (shareable(id, recordOf(desktop, id)))
      await call(registry, accountsState.profileResend, primaryId, {
        profileId: BrowserProfileId.make(id),
        why: "send-again",
      });
}

const WITHDRAW_LIMIT_MS = 5_000;

/**
 * Before a remote is removed: its copies of this desktop's sign-ins are deleted there, if it
 * answers within 5 s. Removal never waits longer; an offline remote keeps them until it finds
 * this desktop's access revoked.
 */
export async function withdrawCopies(environmentId: EnvironmentId) {
  const primaryId = readPrimaryEnvironmentId();
  if (!primaryId || primaryId === environmentId || !window.desktopBridge?.accounts?.readSessions)
    return "none" as const;
  const kept = await call(appAtomRegistry, accountsState.senderKey, primaryId, {
    environmentId,
  }).catch(() => undefined);
  const withdrawn = kept?.key
    ? call(appAtomRegistry, accountsState.sessionsWithdraw, environmentId, {
        source: primaryId,
        key: kept.key,
        all: true,
      }).then(
        () => "withdrawn" as const,
        () => "offline" as const,
      )
    : Promise.resolve("none" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"offline">((resolve) => {
    timer = setTimeout(() => resolve("offline"), WITHDRAW_LIMIT_MS);
  });
  const outcome = await Promise.race([withdrawn, timeout]).finally(() => clearTimeout(timer));
  // Delivery stops either way, and no deletion waits for this computer any more. The key goes
  // only after a confirmed withdrawal; kept, a later link proves this desktop and reconciles.
  await call(appAtomRegistry, accountsState.profilesUnshared, primaryId, {
    environmentId,
    ...(outcome === "withdrawn" ? { forgetKey: true as const } : {}),
  }).catch(() => undefined);
  if (outcome === "offline" && readEnvironment(environmentId)) return "offline" as const;
  return outcome;
}

/** After removing a computer that didn't answer: its copies stay until this desktop's access goes. */
export const copiesStayToast = (label: string) => ({
  type: "info" as const,
  title: `${label} is offline`,
  description: `The sign-ins copied there stay until you remove this computer's access on ${label}.`,
});
