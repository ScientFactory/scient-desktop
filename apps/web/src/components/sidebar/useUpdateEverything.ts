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
import { canUpdateServer, type ServerUpdateOutcome, useServerUpdate } from "../ServerUpdateAction";
import {
  closeFinishedUpdateRun,
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
  waitForServerUpdateHandoff,
  waitForUpdateRestart,
} from "./updateEverythingRun";
// SCIENT-FORK:START — T3 npm publication does not qualify a Scient server artifact.
import { useScientServerReleasePublished } from "~/scient/desktopUpdate/serverReleaseAvailability";
import {
  currentConfirmedServerTargets,
  supportedBulkServerTargets,
  unsupportedBulkServerMachines,
} from "./updateEverything.logic";
import { publishQualifiedUpdateRunServers } from "./updateEverythingRun";
import {
  collectOtherServerUpdates,
  isSelfUpdatingSshRemote,
} from "~/scient/desktopUpdate/otherUpdates.logic";
import {
  managedRuntimeProviderMachines,
  managedRuntimeRunOutcomes,
  useManagedRuntimeUpdates,
} from "~/scient/providerConnection/useManagedRuntimeUpdates";
import { isMachineUpdating } from "~/scient/desktopUpdate/useOtherUpdates";
import { releaseUpdateRunServer } from "~/scient/desktopUpdate/updateRunServers";
import type { ServerUpdateTarget } from "../ServerUpdateAction";
// SCIENT-FORK:END

const UPDATE_RESTART_DELAY_MS = 5_000;

export type ReportLocalUpdateError = (title: string, description: string) => void;

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Remote desktop apps follow their own
 * feed. Exact server-package targets require owned availability proof. `run`
 * performs the whole pass, including this app's own download and install when
 * given. It updates quietly, tracks each machine in the run state, and reports
 * one summary toast at the end. This app relaunches once every server restarts
 * into its update, after a short countdown the user can postpone. The summary
 * then waits for the relaunch, and servers still restarting are followed after it.
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
    // A failed server's Retry rechecks the same eligibility.
    publishQualifiedUpdateRunServers(servers);
  }, [committedServersRef, servers]);
  useLayoutEffect(
    () => () => {
      // A delayed pass or retry cannot retain eligibility after its sidebar owner leaves.
      committedServersRef.current = [];
      publishQualifiedUpdateRunServers([]);
    },
    [committedServersRef],
  );
  // An SSH remote this app launches from its own package follows it on the next connection.
  const selfUpdating = new Set(
    environments.filter(isSelfUpdatingSshRemote).map((environment) => environment.environmentId),
  );
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable.filter((machine) => !selfUpdating.has(machine.environmentId)),
    ...unsupportedBulkServerMachines(behindServers, servers),
  ];
  // Reviewed Scient-managed runtimes update with the providers.
  const managedRuntimes = useManagedRuntimeUpdates();
  // The sidebar's circle lists each server a pass may update.
  const otherServers = collectOtherServerUpdates(machines, servers);
  // SCIENT-FORK:END
  const restarts = collectRestartingMachines(machines, servers, localUpdateVersion !== null);
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    // SCIENT-FORK:START — managed runtimes are part of the pass.
    providerMachines: [
      ...providers.machines.map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        providers: machine.candidates.map(
          (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
        ),
      })),
      ...managedRuntimeProviderMachines(managedRuntimes.targets),
    ],
    // SCIENT-FORK:END
  });

  return {
    // SCIENT-FORK:START — managed runtimes are part of the pass.
    hasUpdates:
      servers.length > 0 || providers.machines.length > 0 || managedRuntimes.targets.length > 0,
    // SCIENT-FORK:END
    summary,
    lines,
    restarts,
    skipped,
    // SCIENT-FORK:START — the sidebar's circle for other machines and providers.
    otherServers,
    // SCIENT-FORK:END
    run: async ({
      downloadLocal,
      installLocal,
      // SCIENT-FORK:START — the circle admits each server again when its restart is due.
      admitServer,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      admitServer?: (target: ServerUpdateTarget) => boolean;
      // SCIENT-FORK:END
    }) => {
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        localVersion,
        phase: "providers",
        restartAt: null,
        machines: Array.from(machinesById.values()),
      }));
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            // SCIENT-FORK:START — managed runtimes update beside the providers; one staged to
            // switch when idle is handed off, so servers need not wait for its running turns.
            const [runs, managedRuns] = await Promise.all([
              providers.updateAll({ quiet: true }),
              managedRuntimes.update(managedRuntimes.targets, { inPass: true }),
            ]);
            // SCIENT-FORK:END
            const outcomes = runs.map((run) => {
              const runOutcome = getProviderUpdateRunOutcome(run);
              if (runOutcome.status !== "updated") {
                providerFailures.set(
                  run.environmentId,
                  runOutcome.status === "failed" ? runOutcome.line : "Provider update interrupted",
                );
              }
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (machine.server === null) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  providerFailures.get(machine.environmentId) ?? null,
                );
              }
            }
            const serversStartedAt = Date.now();
            setUpdateEverythingRun(
              (run) =>
                run && {
                  ...run,
                  phase: "servers",
                  machines: run.machines.map((machine) =>
                    machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
                  ),
                },
            );
            // SCIENT-FORK:START — managed runtimes are part of the pass.
            return [...outcomes, ...managedRuntimeRunOutcomes(managedRuns)];
            // SCIENT-FORK:END
          },
          // SCIENT-FORK:START — only servers still eligible after the provider step update. A
          // server withdrawn meanwhile (availability, eligibility, or the sidebar leaving) is
          // settled as not updated, named in the summary, and offered Retry once eligible again.
          updateServers: async () => {
            const current = currentConfirmedServerTargets(servers, committedServersRef.current);
            const withdrawn = servers.filter(
              (server) => !current.some((target) => target.environmentId === server.environmentId),
            );
            const withdrawnRuns = withdrawn.map((server) => {
              const message = "Not updated; it was no longer eligible when servers updated.";
              settleUpdateRunMachine(server.environmentId, message, {
                providerFailure: providerFailures.get(server.environmentId) ?? null,
              });
              const finished = {
                label: server.serverLabel,
                outcome: { status: "failed" as const, message },
              };
              finishedServers.push(finished);
              return Promise.resolve(finished);
            });
            // A server whose machine is still updating a provider, or that the caller no longer
            // admits, is left to the sidebar's circle, which offers it again when it can restart.
            const admitted = current.filter(
              (server) =>
                !isMachineUpdating(server.environmentId) && (admitServer?.(server) ?? true),
            );
            for (const server of current) {
              if (!admitted.includes(server)) {
                releaseUpdateRunServer(
                  server.environmentId,
                  providerFailures.get(server.environmentId) ?? null,
                );
              }
            }
            const runs = admitted.map(async (server) => {
              const serverOutcome = await updateServer(server, { quiet: true });
              settleUpdateRunMachine(
                server.environmentId,
                serverOutcome.status === "failed"
                  ? serverOutcome.message
                  : (providerFailures.get(server.environmentId) ?? null),
                {
                  serverUpdated: serverOutcome.status !== "failed",
                  providerFailure: providerFailures.get(server.environmentId) ?? null,
                },
              );
              const finished = { label: server.serverLabel, outcome: serverOutcome };
              finishedServers.push(finished);
              return finished;
            });
            await Promise.all(
              admitted.map((server, index) =>
                waitForServerUpdateHandoff(server.environmentId, runs[index]!),
              ),
            );
            return [...withdrawnRuns, ...runs];
          },
          // SCIENT-FORK:END
        });
        const result = (finished: ReadonlyArray<{ label: string; outcome: ServerUpdateOutcome }>) =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            servers: finished,
            providers: outcome.providers,
          });
        if (outcome.localReady && installLocal) {
          if (await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS)) {
            setUpdateEverythingRun(
              (run) => run && { ...run, phase: "installing", restartAt: null },
            );
            saveUpdateEverythingResult({ ...result(finishedServers), localVersion });
            if (await installLocal(reportLocalError)) return;
            clearSavedUpdateEverythingResult();
          }
        }
        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
              restartAt: null,
              localVersion: null,
            }),
        );
        showUpdateEverythingResult(result(await Promise.all(outcome.servers)));
      } catch (error) {
        setUpdateEverythingRun(() => null);
        throw error;
      }
    },
  };
}
