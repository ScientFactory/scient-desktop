import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useLayoutEffect, useMemo, useRef } from "react";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  describeUpdateEverything,
  runUpdateEverything,
} from "./updateEverything.logic";
// SCIENT-FORK:START — T3 npm publication does not qualify a Scient server artifact.
import { useScientServerReleasePublished } from "~/scient/desktopUpdate/serverReleaseAvailability";
// Provider updates include Scient-managed runtimes, each line with its versions.
import { describeProviderUpdateItem } from "~/scient/providerUpdates/providerUpdateInventory";
import { useProviderUpdateInventory } from "~/scient/providerUpdates/useProviderUpdateInventory";
import { describeUpdateEverythingDetails } from "~/scient/desktopUpdate/sidebarUpdateButton";
import {
  appProviderSnapshots,
  waitForManagedRuntimesIdle,
} from "~/scient/providerUpdates/managedRuntimeUpdateWatch";
import {
  currentConfirmedServerTargets,
  supportedBulkServerTargets,
} from "./updateEverything.logic";
// SCIENT-FORK:END

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Remote desktop apps follow their own
 * feed. Exact server-package targets require owned availability proof. `run` performs the pass, including
 * this app's own download and install when given.
 */
export function useUpdateEverything(localUpdateVersion: string | null) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const machinesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          serverConfig: environment.serverConfig,
          connected: environment.connection.phase === "connected",
          hostedByThisApp:
            isElectron &&
            (environment.entry.target._tag === "PrimaryConnectionTarget" ||
              isDesktopLocalConnectionTarget(environment.entry.target)),
          canMaintain: canUpdateServer(
            get(environmentSession.sessionStateAtom(environment.environmentId)),
          ),
          updateState: get(serverEnvironment.updateStateAtom(environment.environmentId)),
        })),
      ),
    [environments],
  );
  const machines = useAtomValue(machinesAtom);
  const behindServers = collectServerUpdateTargets(machines, targetVersion);
  // SCIENT-FORK:START — do not advertise or dispatch an unqualified exact artifact target.
  const needsExactArtifact = behindServers.some(
    (server) => server.selfUpdate !== "desktop-managed",
  );
  const exactArtifactAvailable = useScientServerReleasePublished(
    needsExactArtifact ? targetVersion : null,
  );
  const servers = supportedBulkServerTargets(behindServers, exactArtifactAvailable);
  const committedServersRef = useRef(servers);
  useLayoutEffect(() => {
    committedServersRef.current = servers;
    return () => {
      // A delayed pass cannot retain eligibility after its sidebar owner leaves.
      committedServersRef.current = [];
    };
  }, [servers]);
  // SCIENT-FORK:END
  const restarts = collectRestartingMachines(machines, servers, localUpdateVersion !== null);
  // SCIENT-FORK: managed runtimes included; see useProviderUpdateInventory.
  const providers = useProviderUpdateInventory();
  const updateServer = useServerUpdate();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      // SCIENT-FORK: one line per runtime, with versions and owner.
      providers: machine.items.map(describeProviderUpdateItem),
    })),
  });

  // SCIENT-FORK:START — what the sidebar tooltip lists, and what Restart leaves for afterwards.
  const scient = {
    details: describeUpdateEverythingDetails({
      localVersion: localUpdateVersion,
      servers,
      providerMachines: providers.machines,
    }),
    remoteSummary:
      servers.length > 0 || providers.machines.length > 0
        ? describeUpdateEverything({
            localVersion: null,
            servers,
            providerMachines: providers.machines.map((machine) => ({
              environmentId: machine.environmentId,
              label: machine.label,
              providers: machine.items.map(describeProviderUpdateItem),
            })),
          }).summary
        : null,
  };
  // SCIENT-FORK:END

  return {
    scient,
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    /** Short label for the tooltip and the confirmation title. */
    summary,
    /** One line per machine, for the confirmation. */
    lines,
    /** The servers this run restarts, which stops their running threads. */
    restarts,
    run: (local: { downloadLocal?: () => Promise<boolean>; installLocal?: () => Promise<void> }) =>
      runUpdateEverything({
        ...local,
        // SCIENT-FORK:START — a server restarts, and this app installs, only once no
        // managed runtime on that machine is mid-update, whoever started it.
        ...(local.installLocal
          ? {
              installLocal: async () => {
                await waitForManagedRuntimesIdle(
                  appProviderSnapshots,
                  machines
                    .filter((machine) => machine.hostedByThisApp)
                    .map((machine) => machine.environmentId),
                );
                await local.installLocal!();
              },
            }
          : {}),
        // SCIENT-FORK:END
        updateProviders: providers.updateAll,
        updateServers: async () => {
          // SCIENT-FORK:START — see installLocal above. The wait can be long, so
          // eligibility is confirmed again after it, and can only narrow.
          const gated = currentConfirmedServerTargets(servers, committedServersRef.current);
          await waitForManagedRuntimesIdle(
            appProviderSnapshots,
            gated.map((server) => server.environmentId),
          );
          const current = currentConfirmedServerTargets(gated, committedServersRef.current);
          // SCIENT-FORK:END
          await Promise.all(current.map((server) => updateServer(server)));
        },
      }),
  };
}
