import { useCallback, useEffect, useMemo, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  settleManagedRuntimeUpdateRuns,
  type ManagedRuntimeUpdateRun,
} from "../providerConnection/ManagedRuntimeUpdateNotification.logic";
import { useStartProviderRuntimeAction } from "../providerConnection/useProviderLifecycleController";
import {
  collectProviderUpdateMachines,
  getProviderUpdateResultsToastView,
  runProviderUpdates,
  systemProviderUpdateOutcome,
  type ProviderUpdateEnvironment,
  type ProviderUpdateItem,
  type ProviderUpdateOutcome,
} from "./providerUpdateInventory";

const UNSTARTED_MANAGED_UPDATE: ProviderUpdateOutcome = {
  status: "failed",
  message: "Scient could not start the update. Review the provider in Settings.",
};

/**
 * Every runtime with a one-click update on every connected machine, Scient's
 * managed copies included, and a function that updates them all and reports
 * every result in one notice. The returned promise settles when each update
 * has finished: a managed one once its new runtime is active.
 */
export function useProviderUpdateInventory() {
  const { environments } = useEnvironments();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const startRuntimeAction = useStartProviderRuntimeAction();
  const snapshots = useMemo(
    (): ProviderUpdateEnvironment[] =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
        providers: environment.serverConfig?.providers ?? [],
      })),
    [environments],
  );
  const machines = useMemo(() => collectProviderUpdateMachines(snapshots), [snapshots]);

  // Managed updates finish in later provider snapshots; each waiter rechecks its run.
  const snapshotsRef = useRef(snapshots);
  const waitersRef = useRef(new Set<() => void>());
  useEffect(() => {
    snapshotsRef.current = snapshots;
    for (const check of waitersRef.current) check();
  }, [snapshots]);

  const waitForManaged = useCallback(
    (item: ProviderUpdateItem, operationId: string) =>
      new Promise<ProviderUpdateOutcome>((resolve) => {
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
        const check = () => {
          run = settleManagedRuntimeUpdateRuns([run], snapshotsRef.current)[0] ?? run;
          if (run.outcome.status === "pending") return;
          waitersRef.current.delete(check);
          resolve(run.outcome);
        };
        waitersRef.current.add(check);
        check();
      }),
    [],
  );

  const updateAll = async () => {
    const results = await runProviderUpdates(machines, {
      updateSystem: async (item) =>
        systemProviderUpdateOutcome(
          item,
          await updateProvider({
            environmentId: item.environmentId,
            input: { provider: item.driver, instanceId: item.instanceId },
          }),
        ),
      startManaged: async (item) => {
        const provider = await startRuntimeAction({
          environmentId: item.environmentId,
          instanceId: item.instanceId,
          action: "update",
        });
        const operationId = provider.connection?.runtime?.operation?.operationId ?? null;
        return {
          finished:
            operationId === null
              ? Promise.resolve(UNSTARTED_MANAGED_UPDATE)
              : waitForManaged(item, operationId),
        };
      },
    });
    const view = getProviderUpdateResultsToastView(results);
    if (view) {
      toastManager.add(
        stackedThreadToast({
          ...view,
          description: <span className="whitespace-pre-line">{view.description}</span>,
        }),
      );
    }
  };

  return { machines, updateAll };
}
