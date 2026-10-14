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

/** Resolves once `check` returns a value, rechecking on every snapshot change. */
function whenSettled<A>(
  source: ProviderSnapshotSource,
  check: (environments: ReadonlyArray<LiveProviderEnvironment>) => A | undefined,
): Promise<A> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const recheck = () => {
      if (settled) return;
      const result = check(source.read());
      if (result === undefined) return;
      settled = true;
      unsubscribe?.();
      resolve(result);
    };
    unsubscribe = source.subscribe(recheck);
    recheck();
    if (settled) unsubscribe();
  });
}

/**
 * The final result of a started managed update: its new runtime active, or
 * why not. Waits through a reconnect; losing the environment fails it.
 */
export function watchManagedRuntimeUpdate(
  source: ProviderSnapshotSource,
  item: ProviderUpdateItem,
  operationId: string,
): Promise<ProviderUpdateOutcome> {
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
  return whenSettled(source, (environments): ProviderUpdateOutcome | undefined => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === item.environmentId,
    );
    if (!environment || environment.connection === "lost") {
      return { status: "failed", message: DISCONNECTED_MANAGED_UPDATE_MESSAGE };
    }
    if (environment.connection === "reconnecting") return undefined;
    run = settleManagedRuntimeUpdateRuns([run], [environment])[0] ?? run;
    return run.outcome.status === "pending" ? undefined : run.outcome;
  });
}

/**
 * Resolves when no connected environment has a managed runtime operation in
 * progress, whoever started it, so a restart cannot cut one off.
 */
export function waitForManagedRuntimesIdle(source: ProviderSnapshotSource): Promise<void> {
  return whenSettled(source, (environments) =>
    environments.some(
      (environment) =>
        environment.connection === "connected" &&
        environment.providers.some((provider) =>
          isManagedRuntimeOperationActive(provider.connection?.runtime?.operation),
        ),
    )
      ? undefined
      : true,
  ).then(() => undefined);
}
