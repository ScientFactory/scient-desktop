import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { getProviderUpdateRunToastView } from "~/components/ProviderUpdateLaunchNotification.logic";
import { type ServerUpdateTarget, useServerUpdate } from "~/components/ServerUpdateAction";
import {
  useQualifiedUpdateRunServers,
  useUpdateEverythingRun,
} from "~/components/sidebar/updateEverythingRun";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentProviders, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { managedRuntimeUpdateTargetKey } from "~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic";
import {
  connectedProviderEnvironments,
  managedRuntimeRunsOn,
  useManagedRuntimeUpdates,
} from "~/scient/providerConnection/useManagedRuntimeUpdates";
import {
  buildOtherUpdateRows,
  collectProviderUpdateItems,
  failedUpdateRunServer,
  isThreadRunning,
  machineHasUpdatesRunning,
  managedUpdateLive,
  otherUpdatesCircleState,
  providerDriverUpdateLive,
  serverRetryTarget,
  serverUpdateItem,
  serverUpdateLive,
  trackUpdatingRows,
  type OtherServerUpdate,
  type OtherUpdateItem,
  type OtherUpdateRow,
  type TrackedOtherUpdate,
} from "./otherUpdates.logic";
import { forgetUpdateRunServer, retryUpdateRunServer } from "./updateRunServers";

const trackedOtherUpdatesAtom = Atom.make<ReadonlyMap<string, TrackedOtherUpdate>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("scient-other-updates-tracked"),
);

function environmentIdsOf(key: string): EnvironmentId[] {
  return key
    .split("\n")
    .filter((id) => id !== "")
    .map((id) => EnvironmentId.make(id));
}

const serverUpdateStatesAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    (get) =>
      new Map(
        environmentIdsOf(environmentIds).map(
          (environmentId) =>
            [environmentId, get(serverEnvironment.updateStateAtom(environmentId))] as const,
        ),
      ),
  ).pipe(Atom.withLabel(`scient-other-updates-server-states:${environmentIds}`)),
);

const runningThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).filter(isThreadRunning)
        .length,
  ).pipe(Atom.withLabel(`scient-other-updates-running-threads:${environmentId}`)),
);

/** Per-machine counts that only notify readers when a count changes. */
const runningThreadCountsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIdsOf(environmentIds).map(
      (environmentId) => [environmentId, get(runningThreadCountAtom(environmentId))] as const,
    ),
  ).pipe(
    Atom.withEquality(Equal.equals),
    Atom.withLabel(`scient-other-updates-running-threads:${environmentIds}`),
  ),
);

function stopsThreads(target: ServerUpdateTarget): boolean {
  return !(target.threadContinuation && target.continueThreadsAfterServerUpdate);
}

/** Running threads a server update would stop now: those that cannot resume after it. */
function stoppedThreadsNow(target: ServerUpdateTarget): number {
  return stopsThreads(target)
    ? appAtomRegistry.get(runningThreadCountAtom(target.environmentId))
    : 0;
}

/**
 * What updating these servers would stop now, and an admission that restarts each one only
 * while it would stop no more threads than that: what the user agreed to.
 */
export function confirmServerStops(targets: ReadonlyArray<ServerUpdateTarget>) {
  const confirmed = new Map(
    targets.map((target) => [target.environmentId, stoppedThreadsNow(target)] as const),
  );
  return {
    stops: [...confirmed.values()].reduce((sum, count) => sum + count, 0),
    admitServer: (target: ServerUpdateTarget) =>
      stoppedThreadsNow(target) <= (confirmed.get(target.environmentId) ?? 0),
  };
}

function startsPendingOn(
  tracked: ReadonlyMap<string, TrackedOtherUpdate>,
  environmentId: EnvironmentId,
): boolean {
  return [...tracked.values()].some(
    ({ item, action }) =>
      item.kind !== "server" &&
      item.environmentId === environmentId &&
      action?.status === "pending",
  );
}

/**
 * Whether a server update must not start on this machine right now, read at the moment of
 * dispatch: a provider or managed runtime update is starting or running there.
 */
export function isMachineUpdating(environmentId: EnvironmentId): boolean {
  return machineHasUpdatesRunning({
    providers: appAtomRegistry.get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
    managedRuns: managedRuntimeRunsOn(environmentId),
    startsPending: startsPendingOn(appAtomRegistry.get(trackedOtherUpdatesAtom), environmentId),
  });
}

const IDLE_SERVER_STATE: ServerUpdateState = { status: "idle" };

function updateTracked(update: (tracked: Map<string, TrackedOtherUpdate>) => void): void {
  appAtomRegistry.update(trackedOtherUpdatesAtom, (tracked) => {
    const next = new Map(tracked);
    update(next);
    return next;
  });
}

function track(item: OtherUpdateItem, action: TrackedOtherUpdate["action"]): void {
  updateTracked((tracked) => {
    tracked.set(item.key, { item, action });
  });
}

/** Forgets finished rows, which report "done" until the card has shown them. */
function forget(keys: ReadonlyArray<string>): void {
  if (keys.length === 0) return;
  updateTracked((tracked) => {
    for (const key of keys) tracked.delete(key);
  });
}

function providerUpdateFailure(
  result: AtomCommandResult<{ readonly providers: ReadonlyArray<ServerProvider> }, unknown>,
  instanceId: ServerProvider["instanceId"],
): TrackedOtherUpdate["action"] {
  if (isAtomCommandInterrupted(result)) return null;
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "Provider update failed.",
    };
  }
  const state = result.value.providers.find(
    (provider) => provider.instanceId === instanceId,
  )?.updateState;
  return state?.status === "failed"
    ? { status: "failed", reason: state.message ?? "Provider update failed." }
    : null;
}

/**
 * Updates for other machines and providers: one-click provider CLIs, Scient-managed runtimes
 * and remote servers. Rows follow each machine's own report, so updates started anywhere show
 * here, and a row seen updating reports "done" until the card shows it. Updates started here
 * report their progress and results like updates started elsewhere.
 */
export function useOtherUpdates(servers: ReadonlyArray<OtherServerUpdate>) {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const run = useUpdateEverythingRun();
  const qualifiedServers = useQualifiedUpdateRunServers();
  const tracked = useAtomValue(trackedOtherUpdatesAtom);
  const managed = useManagedRuntimeUpdates();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const updateServer = useServerUpdate();

  const local = new Set(
    environments
      .filter((environment) => environment.entry.target._tag === "PrimaryConnectionTarget")
      .map((environment) => environment.environmentId),
  );
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const machines = connectedProviderEnvironments(environments, providersByEnvironment).map(
    (machine) => ({
      ...machine,
      isLocal: local.has(machine.environmentId),
    }),
  );
  const items = [...collectProviderUpdateItems(machines), ...servers.map(serverUpdateItem)];
  const serverIdsKey = [
    ...new Set(
      [...items, ...[...tracked.values()].map(({ item }) => item)]
        .filter((item) => item.kind === "server")
        .map((item) => item.environmentId),
    ),
  ]
    .toSorted()
    .join("\n");
  const serverStates = useAtomValue(serverUpdateStatesAtom(serverIdsKey));
  const runningThreads = new Map(useAtomValue(runningThreadCountsAtom(serverIdsKey)));
  const providersByMachine = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const providerOf = (environmentId: EnvironmentId, instanceId: ServerProvider["instanceId"]) =>
    providersByMachine
      .get(environmentId)
      ?.providers.find((provider) => provider.instanceId === instanceId);

  const rows = buildOtherUpdateRows({
    items,
    tracked,
    run,
    qualifiedServers,
    environments: new Set(labels.keys()),
    liveOf: (item) => {
      switch (item.kind) {
        case "provider":
          return providerDriverUpdateLive(
            providersByMachine
              .get(item.environmentId)
              ?.providers.filter((provider) => provider.driver === item.driver) ?? [],
          );
        case "managed":
          return managedUpdateLive(
            providerOf(item.environmentId, item.target.instanceId),
            managed.runs.get(managedRuntimeUpdateTargetKey(item.target)),
          );
        case "server":
          return serverUpdateLive(serverStates.get(item.environmentId) ?? IDLE_SERVER_STATE);
      }
    },
  });
  const listedKey = items.map((item) => item.key).join("\n");

  useEffect(() => {
    // Rows were derived from this render's tracking; a newer write gets its own render.
    if (appAtomRegistry.get(trackedOtherUpdatesAtom) !== tracked) return;
    const next = trackUpdatingRows(tracked, rows, new Set(listedKey.split("\n")));
    if (next !== null) appAtomRegistry.set(trackedOtherUpdatesAtom, next);
  }, [listedKey, rows, tracked]);

  const update = async (item: OtherUpdateItem): Promise<void> => {
    switch (item.kind) {
      case "managed":
        track(item, null);
        await managed.update([item.target]);
        return;
      case "provider": {
        track(item, { status: "pending" });
        const result = await updateProvider({
          environmentId: item.environmentId,
          input: { provider: item.driver, instanceId: item.instanceId },
        });
        track(item, providerUpdateFailure(result, item.instanceId));
        const view = getProviderUpdateRunToastView([
          {
            environmentId: item.environmentId,
            machineLabel: labels.get(item.environmentId) ?? item.environmentId,
            driver: item.driver,
            instanceId: item.instanceId,
            result,
          },
        ]);
        if (view) toastManager.add(stackedThreadToast(view));
        return;
      }
      case "server": {
        // Read at the click: a restart would cut off a provider update running there.
        if (isMachineUpdating(item.environmentId)) return;
        // The card's own update replaces whatever a pass recorded for this server.
        forgetUpdateRunServer(item.environmentId);
        track(item, { status: "pending" });
        const outcome = await updateServer(item.target);
        track(
          item,
          outcome.status === "failed" ? { status: "failed", reason: outcome.message } : null,
        );
      }
    }
  };

  const retry = (row: OtherUpdateRow): void => {
    if (row.item.kind !== "server") {
      void update(row.item);
      return;
    }
    if (isMachineUpdating(row.item.environmentId)) return;
    if (failedUpdateRunServer(run, row.item.environmentId) !== null) {
      retryUpdateRunServer(row.item.environmentId, qualifiedServers, updateServer);
      return;
    }
    const state = serverStates.get(row.item.environmentId);
    const attempted = tracked.get(row.item.key)?.item ?? row.item;
    if (attempted.kind !== "server") return;
    const target = serverRetryTarget(
      state?.status === "failed"
        ? { ...attempted.target, targetVersion: state.targetVersion }
        : attempted.target,
      qualifiedServers,
    );
    if (target !== null) void update({ ...row.item, target });
  };

  /** Running threads a server update would stop: those that cannot resume after it. */
  const stoppedThreads = (item: OtherUpdateItem): number =>
    item.kind === "server" && stopsThreads(item.target)
      ? (runningThreads.get(item.environmentId) ?? 0)
      : 0;

  /** A server that must wait: its machine is still updating a provider or runtime. */
  const busy = (item: OtherUpdateItem): boolean =>
    item.kind === "server" &&
    machineHasUpdatesRunning({
      providers: providersByMachine.get(item.environmentId)?.providers ?? [],
      managedRuns: [...managed.runs.values()].filter(
        (managedRun) => managedRun.target.environmentId === item.environmentId,
      ),
      startsPending: startsPendingOn(tracked, item.environmentId),
    });

  return {
    rows,
    circle: otherUpdatesCircleState(rows),
    update: (item: OtherUpdateItem) => void update(item),
    retry,
    forget,
    stoppedThreads,
    busy,
  };
}
