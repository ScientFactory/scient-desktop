import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";

import {
  DISCONNECTED_MANAGED_UPDATE_MESSAGE,
  isManagedRuntimeOperationActive,
  settleManagedRuntimeUpdateRuns,
  type ManagedRuntimeUpdateRun,
} from "../providerConnection/ManagedRuntimeUpdateNotification.logic";
import type { ProviderUpdateItem, ProviderUpdateOutcome } from "./providerUpdateInventory";

/** One environment's live provider snapshot and how far it can be trusted. */
export interface LiveProviderEnvironment {
  readonly environmentId: EnvironmentId;
  /**
   * `reconnecting` keeps a cached snapshot that must not settle anything;
   * `lost` will not come back without the user.
   */
  readonly connection: "connected" | "reconnecting" | "lost";
  readonly providers: ReadonlyArray<ServerProvider>;
}

/**
 * How far an environment's snapshot can be trusted. Offline reconnects once
 * the network returns, so it waits like a reconnect; its server may still be
 * running an update.
 */
export function liveConnection(
  phase: EnvironmentConnectionPhase,
): LiveProviderEnvironment["connection"] {
  switch (phase) {
    case "connected":
      return "connected";
    case "offline":
    case "connecting":
    case "reconnecting":
      return "reconnecting";
    case "available":
    case "error":
    case "unsupported":
      return "lost";
  }
}

export interface ProviderSnapshotSource {
  readonly read: () => ReadonlyArray<LiveProviderEnvironment>;
  /** Calls `onChange` after every snapshot change; returns the unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
}

/** The app's environments, read from its atom registry, so no component has to stay mounted. */
export const appProviderSnapshots: ProviderSnapshotSource = {
  read: () =>
    Array.from(
      appAtomRegistry.get(environmentPresentations.presentationsAtom),
      ([environmentId, presentation]) => ({
        environmentId,
        connection: liveConnection(presentation.connection.phase),
        providers: presentation.serverConfig?.providers ?? [],
      }),
    ),
  subscribe: (onChange) =>
    appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, onChange),
};

/**
 * Resolves once `check` returns a value, rechecking on every snapshot change
 * and, when given, every `pollMs` for checks that depend on elapsed time.
 */
function whenSettled<A>(
  source: ProviderSnapshotSource,
  check: (environments: ReadonlyArray<LiveProviderEnvironment>) => A | undefined,
  pollMs?: number,
): Promise<A> {
  return new Promise((resolve) => {
    let settled = false;
    let stop = () => {};
    const recheck = () => {
      if (settled) return;
      const result = check(source.read());
      if (result === undefined) return;
      settled = true;
      stop();
      resolve(result);
    };
    const unsubscribe = source.subscribe(recheck);
    const timer = pollMs === undefined ? undefined : setInterval(recheck, pollMs);
    stop = () => {
      unsubscribe();
      if (timer !== undefined) clearInterval(timer);
    };
    recheck();
  });
}

/** How long a single update waits through a reconnect before reporting lost contact. */
const RECONNECT_GRACE_MS = 2 * 60_000;

/**
 * The final result of a started managed update: its new runtime active, or
 * why not. Waits through a short reconnect; losing the environment, or a
 * reconnect longer than the grace period, fails it. `onWaitingChange` hears
 * whether the staged runtime is waiting for the provider's running work.
 */
export function watchManagedRuntimeUpdate(
  source: ProviderSnapshotSource,
  item: ProviderUpdateItem,
  operationId: string,
  options: {
    readonly reconnectGraceMs?: number;
    readonly onWaitingChange?: (waiting: boolean) => void;
  } = {},
): Promise<ProviderUpdateOutcome> {
  const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  let reconnectingSince: number | null = null;
  let waiting = false;
  const setWaiting = (next: boolean) => {
    if (next === waiting) return;
    waiting = next;
    options.onWaitingChange?.(next);
  };
  let run: ManagedRuntimeUpdateRun = {
    target: {
      environmentId: item.environmentId,
      environmentLabel: item.machineLabel,
      instanceId: item.instanceId,
      driver: item.driver,
      availableVersion: item.offeredVersion,
    },
    operationId,
    observed: false,
    outcome: { status: "pending" },
    waitingMessage: null,
  };
  const lostContact: ProviderUpdateOutcome = {
    status: "failed",
    message: DISCONNECTED_MANAGED_UPDATE_MESSAGE,
  };
  return whenSettled(
    source,
    (environments): ProviderUpdateOutcome | undefined => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === item.environmentId,
      );
      if (!environment || environment.connection === "lost") return lostContact;
      if (environment.connection === "reconnecting") {
        reconnectingSince ??= Date.now();
        return Date.now() - reconnectingSince >= reconnectGraceMs ? lostContact : undefined;
      }
      reconnectingSince = null;
      run = settleManagedRuntimeUpdateRuns([run], [environment])[0] ?? run;
      setWaiting(run.outcome.status === "pending" && run.waitingMessage !== null);
      return run.outcome.status === "pending" ? undefined : run.outcome;
    },
    Math.min(10_000, reconnectGraceMs),
  ).finally(() => setWaiting(false));
}

/**
 * Whether the environment's server reports a managed runtime operation in
 * progress, asked anew over its current connection; rejects when the server
 * does not answer.
 */
export type ReadServerRuntimeActivity = (environmentId: EnvironmentId) => Promise<boolean>;

export const hasActiveManagedOperation = (providers: ReadonlyArray<ServerProvider>) =>
  providers.some((provider) =>
    isManagedRuntimeOperationActive(provider.connection?.runtime?.operation),
  );

/** Settles like `promise`, or rejects once `ms` have passed. */
function withDeadline<A>(promise: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("No answer in time.")), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Whether an environment can restart without cutting off a managed runtime
 * operation, whoever started it. Waits while one runs. Only the server's own
 * answer confirms it, asked once the cached snapshot shows the environment
 * connected and idle: a cached snapshot can predate an update whose answer
 * was lost, even one that still reads connected. False when it cannot be
 * confirmed: the environment is missing or lost, or reconnects, or its server
 * goes unanswered, for longer than the grace period.
 */
async function confirmManagedRuntimesIdle(
  source: ProviderSnapshotSource,
  environmentId: EnvironmentId,
  readServerRuntimeActivity: ReadServerRuntimeActivity,
  reconnectGraceMs: number,
): Promise<boolean> {
  const pollMs = Math.min(10_000, reconnectGraceMs);
  let reconnectingSince: number | null = null;
  let unansweredSince: number | null = null;
  for (;;) {
    const cached = await whenSettled(
      source,
      (environments) => {
        const environment = environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (!environment || environment.connection === "lost") return "lost" as const;
        if (environment.connection === "reconnecting") {
          reconnectingSince ??= Date.now();
          return Date.now() - reconnectingSince >= reconnectGraceMs ? ("lost" as const) : undefined;
        }
        reconnectingSince = null;
        return hasActiveManagedOperation(environment.providers) ? undefined : ("idle" as const);
      },
      pollMs,
    );
    if (cached === "lost") return false;
    // The deadline runs from before the question, so a request that never
    // settles cannot hold the pass.
    unansweredSince ??= Date.now();
    const active = await withDeadline(
      readServerRuntimeActivity(environmentId),
      reconnectGraceMs - (Date.now() - unansweredSince),
    ).then(
      (answer) => answer,
      () => null,
    );
    if (active === null) {
      if (Date.now() - unansweredSince >= reconnectGraceMs) return false;
    } else {
      unansweredSince = null;
      if (!active) return true;
    }
    // Not yet: let the snapshot catch up before asking again.
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The given environments that `confirmManagedRuntimesIdle` could not confirm, once each has settled. */
export async function waitForManagedRuntimesIdle(
  source: ProviderSnapshotSource,
  environmentIds: ReadonlyArray<EnvironmentId>,
  readServerRuntimeActivity: ReadServerRuntimeActivity,
  reconnectGraceMs = RECONNECT_GRACE_MS,
): Promise<ReadonlySet<EnvironmentId>> {
  const ids = [...new Set(environmentIds)];
  const confirmed = await Promise.all(
    ids.map((environmentId) =>
      confirmManagedRuntimesIdle(
        source,
        environmentId,
        readServerRuntimeActivity,
        reconnectGraceMs,
      ),
    ),
  );
  return new Set(ids.filter((_, index) => !confirmed[index]));
}
