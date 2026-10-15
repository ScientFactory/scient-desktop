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
import { managedRuntimeGatedSteps } from "~/scient/providerUpdates/managedRuntimeRestartGate";
import { supportedBulkServerTargets } from "./updateEverything.logic";
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
  // SCIENT-FORK:START — managed runtimes included; see useProviderUpdateInventory.
  const providers = useProviderUpdateInventory();
  // SCIENT-FORK:END
  const updateServer = useServerUpdate();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      // SCIENT-FORK:START — one line per runtime, with versions and owner.
      providers: machine.items.map(describeProviderUpdateItem),
      // SCIENT-FORK:END
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    /** Short label for the tooltip and the confirmation title. */
    summary,
    /** One line per machine, for the confirmation. */
    lines,
    /** The servers this run restarts, which stops their running threads. */
    restarts,
    run: (local: {
      downloadLocal?: () => Promise<boolean>;
      installLocal?: () => Promise<void>;
      // SCIENT-FORK:START — whether a managed update is waiting for running work.
      onWaitingChange?: (waiting: boolean) => void;
      // SCIENT-FORK:END
    }) =>
      runUpdateEverything({
        ...local,
        // SCIENT-FORK:START — a server restarts, and this app installs, only once no
        // managed runtime on that machine is mid-update, whoever started it, and
        // not at all while that cannot be confirmed.
        ...managedRuntimeGatedSteps({
          updateAll: providers.updateAll,
          onWaitingChange: local.onWaitingChange,
          readServerRuntimeActivity: providers.readServerRuntimeActivity,
          servers,
          currentServers: () => committedServersRef.current,
          updateServer: (server) => updateServer(server),
          hostedEnvironmentIds: machines
            .filter((machine) => machine.hostedByThisApp)
            .map((machine) => machine.environmentId),
          installLocal: local.installLocal,
        }),
        // SCIENT-FORK:END
      }),
  };
}
