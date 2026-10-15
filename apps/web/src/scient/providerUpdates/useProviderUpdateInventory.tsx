import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMemo } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { useStartProviderRuntimeAction } from "../providerConnection/useProviderLifecycleController";
import {
  appProviderSnapshots,
  watchManagedRuntimeUpdate,
  type ReadServerProviders,
} from "./managedRuntimeUpdateWatch";
import {
  collectProviderUpdateMachines,
  getProviderUpdateResultsToastView,
  runProviderUpdates,
  systemProviderUpdateOutcome,
  type ProviderUpdateEnvironment,
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
 * has finished: a managed one once its new runtime is active. The run does not
 * depend on the calling component staying mounted. `onWaitingChange` hears
 * whether any managed update is waiting for its provider's running work.
 */
export function useProviderUpdateInventory() {
  const { environments } = useEnvironments();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
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

  const updateAll = async (
    options: { readonly onWaitingChange?: (waiting: boolean) => void } = {},
  ) => {
    let waitingCount = 0;
    const onWaitingChange = (waiting: boolean) => {
      waitingCount += waiting ? 1 : -1;
      if (waitingCount === (waiting ? 1 : 0)) options.onWaitingChange?.(waiting);
    };
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
              : watchManagedRuntimeUpdate(appProviderSnapshots, item, operationId, {
                  onWaitingChange,
                }),
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

  /** A machine's current provider list, from its server rather than the cached snapshot. */
  const readServerProviders: ReadServerProviders = async (environmentId) => {
    const result = await refreshProviders({ environmentId, input: {} });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.providers;
  };

  return { machines, updateAll, readServerProviders };
}
