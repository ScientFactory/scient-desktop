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
  /** `reconnecting` keeps a cached snapshot that must not settle anything. */
  readonly connection: "connected" | "reconnecting" | "lost";
  readonly providers: ReadonlyArray<ServerProvider>;
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
        connection:
          presentation.connection.phase === "connected"
            ? "connected"
            : presentation.connection.phase === "connecting" ||
                presentation.connection.phase === "reconnecting"
              ? "reconnecting"
              : "lost",
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
 * reconnect longer than the grace period, fails it.
 */
export function watchManagedRuntimeUpdate(
  source: ProviderSnapshotSource,
  item: ProviderUpdateItem,
  operationId: string,
  reconnectGraceMs = RECONNECT_GRACE_MS,
): Promise<ProviderUpdateOutcome> {
  let reconnectingSince: number | null = null;
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
      return run.outcome.status === "pending" ? undefined : run.outcome;
    },
    Math.min(10_000, reconnectGraceMs),
  );
}

/**
 * Resolves when none of the given environments has a managed runtime
 * operation in progress, whoever started it, so restarting them cannot cut
 * one off. A reconnecting environment still counts its last known operation;
 * a lost one has nothing left to protect.
 */
export function waitForManagedRuntimesIdle(
  source: ProviderSnapshotSource,
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<void> {
  const watched = new Set(environmentIds);
  return whenSettled(source, (environments) =>
    environments.some(
      (environment) =>
        watched.has(environment.environmentId) &&
        environment.connection !== "lost" &&
        environment.providers.some((provider) =>
          isManagedRuntimeOperationActive(provider.connection?.runtime?.operation),
        ),
    )
      ? undefined
      : true,
  ).then(() => undefined);
}
