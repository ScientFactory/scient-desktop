import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useServerUpdate } from "~/components/ServerUpdateAction";
import {
  useQualifiedUpdateRunServers,
  useUpdateEverythingRun,
} from "~/components/sidebar/updateEverythingRun";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { managedRuntimeUpdateTargetKey } from "~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic";
import {
  connectedProviderEnvironments,
  useManagedRuntimeUpdates,
} from "~/scient/providerConnection/useManagedRuntimeUpdates";
import {
  buildOtherUpdateRows,
  collectProviderUpdateItems,
  managedUpdateLive,
  otherUpdatesCircleState,
  providerUpdateLive,
  serverRetryTarget,
  serverUpdateItem,
  serverUpdateLive,
  trackUpdatingRows,
  type OtherServerUpdate,
  type OtherUpdateItem,
  type OtherUpdateRow,
  type TrackedOtherUpdate,
} from "./otherUpdates.logic";

const trackedOtherUpdatesAtom = Atom.make<ReadonlyMap<string, TrackedOtherUpdate>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("scient-other-updates-tracked"),
);

const serverUpdateStatesAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    (get) =>
      new Map(
        environmentIds
          .split("\n")
          .filter((id) => id !== "")
          .map((id) => {
            const environmentId = EnvironmentId.make(id);
            return [environmentId, get(serverEnvironment.updateStateAtom(environmentId))] as const;
          }),
      ),
  ).pipe(Atom.withLabel(`scient-other-updates-server-states:${environmentIds}`)),
);

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
 * Updates for other machines and providers: provider CLIs, Scient-managed runtimes and remote
 * servers. Rows follow each machine's own report, so updates started anywhere show here, and a
 * row seen updating reports "done" until the card shows it.
 */
export function useOtherUpdates(servers: ReadonlyArray<OtherServerUpdate>) {
  const { environments } = useEnvironments();
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
  const machines = connectedProviderEnvironments(environments).map((machine) => ({
    ...machine,
    isLocal: local.has(machine.environmentId),
  }));
  const items = [...collectProviderUpdateItems(machines), ...servers.map(serverUpdateItem)];
  const serverIds = new Set(
    [...items, ...[...tracked.values()].map(({ item }) => item)]
      .filter((item) => item.kind === "server")
      .map((item) => item.environmentId),
  );
  const serverStates = useAtomValue(serverUpdateStatesAtom([...serverIds].toSorted().join("\n")));
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
    liveOf: (item) => {
      switch (item.kind) {
        case "provider":
          return providerUpdateLive(providerOf(item.environmentId, item.instanceId));
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
    const next = trackUpdatingRows(
      appAtomRegistry.get(trackedOtherUpdatesAtom),
      rows,
      new Set(listedKey.split("\n")),
    );
    if (next !== null) appAtomRegistry.set(trackedOtherUpdatesAtom, next);
  }, [listedKey, rows]);

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
        return;
      }
      case "server": {
        if (item.target === null) return;
        track(item, { status: "pending" });
        const outcome = await updateServer(item.target, { quiet: true });
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
    const state = serverStates.get(row.item.environmentId);
    const target = serverRetryTarget(
      tracked.get(row.item.key)?.item ?? row.item,
      state?.status === "failed" ? state.targetVersion : undefined,
      qualifiedServers,
    );
    if (target !== null) void update({ ...row.item, target });
  };

  return {
    rows,
    circle: otherUpdatesCircleState(rows),
    update: (item: OtherUpdateItem) => void update(item),
    retry,
    forget,
  };
}
