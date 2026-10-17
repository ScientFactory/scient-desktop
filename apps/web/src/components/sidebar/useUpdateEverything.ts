import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useLayoutEffect, useMemo, useRef } from "react";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  type SkippedMachine,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
} from "./updateEverythingRun";
// SCIENT-FORK:START — T3 npm publication does not qualify a Scient server artifact.
import { useScientServerReleasePublished } from "~/scient/desktopUpdate/serverReleaseAvailability";
import {
  currentConfirmedServerTargets,
  supportedBulkServerTargets,
  unsupportedBulkServerMachines,
} from "./updateEverything.logic";
// SCIENT-FORK:END

/** Where this app's own download or install reports a failure. */
export type ReportLocalUpdateError = (title: string, description: string) => void;

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Remote desktop apps follow their own
 * feed. Exact server-package targets require owned availability proof. `run`
 * performs the whole pass, including this app's own download and install when
 * given. It updates quietly, tracks each machine in the run state, and reports
 * one summary toast at the end. When this app installs, the summary waits for
 * the relaunch.
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
  const { targets: behindServers, skipped: unreachable } = collectServerUpdateTargets(
    machines,
    targetVersion,
  );
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
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable,
    ...unsupportedBulkServerMachines(behindServers, servers),
  ];
  // SCIENT-FORK:END
  const restarts = collectRestartingMachines(machines, servers, localUpdateVersion !== null);
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
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
    /** Behind machines the run leaves alone, with the reason. */
    skipped,
    /** Runs the pass. `installLocal` resolves true when this app is relaunching.
        Both report failures to the pass, which lists them in its summary. */
    run: async ({
      downloadLocal,
      installLocal,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
    }) => {
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          updatesServer: false,
          result: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          updatesServer: true,
          result: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        localVersion,
        phase: "providers",
        machines: Array.from(machinesById.values()),
      }));
      const failedProviderMachines = new Set<UpdateRunMachine["environmentId"]>();
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            const runs = await providers.updateAll({ quiet: true });
            const outcomes = runs.map((run) => {
              const runOutcome = getProviderUpdateRunOutcome(run);
              // An interrupted update did not finish either, so its row is not "done".
              if (runOutcome.status !== "updated") failedProviderMachines.add(run.environmentId);
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (!machine.updatesServer) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  failedProviderMachines.has(machine.environmentId),
                );
              }
            }
            setUpdateEverythingRun((run) => run && { ...run, phase: "servers" });
            return outcomes;
          },
          // SCIENT-FORK:START — only servers still eligible after the provider step update. A
          // server withdrawn meanwhile (availability, eligibility, or the sidebar leaving) is
          // settled as not updated and named in the summary.
          updateServers: () => {
            const current = currentConfirmedServerTargets(servers, committedServersRef.current);
            const withdrawn = servers.filter(
              (server) => !current.some((target) => target.environmentId === server.environmentId),
            );
            for (const server of withdrawn) settleUpdateRunMachine(server.environmentId, true);
            const withdrawnOutcomes = withdrawn.map((server) => ({
              label: server.serverLabel,
              outcome: {
                status: "failed" as const,
                message: "Not updated; it was no longer eligible when servers updated.",
              },
            }));
            return Promise.all([
              ...withdrawnOutcomes,
              ...current.map(async (server) => {
                const serverOutcome = await updateServer(server, { quiet: true });
                settleUpdateRunMachine(
                  server.environmentId,
                  serverOutcome.status === "failed" ||
                    failedProviderMachines.has(server.environmentId),
                );
                return { label: server.serverLabel, outcome: serverOutcome };
              }),
            ]);
          },
          // SCIENT-FORK:END
        });
        const result = () =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            servers: outcome.servers,
            providers: outcome.providers,
          });
        if (outcome.localReady && installLocal) {
          setUpdateEverythingRun((run) => run && { ...run, phase: "installing" });
          saveUpdateEverythingResult({ ...result(), localVersion });
          if (await installLocal(reportLocalError)) return;
          clearSavedUpdateEverythingResult();
        }
        showUpdateEverythingResult(result());
      } finally {
        setUpdateEverythingRun(() => null);
      }
    },
  };
}
