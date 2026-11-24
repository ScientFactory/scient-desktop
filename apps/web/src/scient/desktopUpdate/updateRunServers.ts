import type { EnvironmentId } from "@t3tools/contracts";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import {
  closeFinishedUpdateRun,
  currentConfirmedServerTargets,
  resolveRestoredRetry,
  type UpdateEverythingMachine,
} from "~/components/sidebar/updateEverything.logic";
import {
  setUpdateEverythingRun,
  settleUpdateRunMachine,
} from "~/components/sidebar/updateEverythingRun";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { resolveVersionMismatch } from "~/versionSkew";

type ServerUpdate = (
  target: ServerUpdateTarget,
  options: { readonly quiet: boolean },
) => Promise<ServerUpdateOutcome>;

/** The server runs `targetVersion` now, read at the click; the host rejects a same-version update. */
function runsTargetVersion(environmentId: EnvironmentId, targetVersion: string | null): boolean {
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  return (
    targetVersion !== null &&
    config !== null &&
    resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
  );
}

/**
 * Retries one server a pass failed or withdrew, keeping its confirmed version and mechanism and
 * sending nothing unless that target is qualified now. A row restored after a relaunch rebuilds
 * its target from `current`; a server already on its target settles. Returns whether it started.
 */
export function retryUpdateRunServer(
  environmentId: EnvironmentId,
  qualified: ReadonlyArray<ServerUpdateTarget>,
  update: ServerUpdate,
  current: ReadonlyArray<UpdateEverythingMachine> = [],
): boolean {
  const found: {
    retry?: { target: ServerUpdateTarget; providerFailure: string | null };
    settled?: { providerFailure: string | null };
  } = {};
  setUpdateEverythingRun((run) => {
    const machine = run?.machines.find(
      (candidate) => candidate.environmentId === environmentId && candidate.result === "failed",
    );
    const attempted = machine && (machine.server ?? resolveRestoredRetry(machine, current));
    if (!run || !machine || !attempted) return run;
    const targetVersion =
      attempted === "current" ? machine.handedOffVersion : attempted.targetVersion;
    if (runsTargetVersion(environmentId, targetVersion)) {
      found.settled = { providerFailure: machine.providerFailure };
      return run;
    }
    if (attempted === "current") return run;
    const target = currentConfirmedServerTargets([attempted], qualified)[0];
    if (!target) return run;
    found.retry = { target, providerFailure: machine.providerFailure };
    const startedAt = Date.now();
    return {
      ...run,
      machines: run.machines.map((candidate) =>
        candidate === machine
          ? {
              ...candidate,
              server: target,
              handedOffVersion: null,
              result: null,
              failure: null,
              startedAt,
            }
          : candidate,
      ),
    };
  });
  if (found.settled !== undefined) {
    settleUpdateRunMachine(environmentId, found.settled.providerFailure, { serverUpdated: true });
    return false;
  }
  const started = found.retry;
  if (started === undefined) return false;
  void update(started.target, { quiet: false }).then((outcome) =>
    settleUpdateRunMachine(
      environmentId,
      outcome.status === "updated"
        ? started.providerFailure
        : outcome.status === "failed"
          ? outcome.message
          : "Could not start the update",
      { serverUpdated: outcome.status === "updated" },
    ),
  );
  return true;
}

/**
 * Leaves a pass's server to the circle without updating it, because its machine is busy or the
 * user did not confirm what it would stop now. Its row offers the update again when it can run.
 */
export function releaseUpdateRunServer(
  environmentId: EnvironmentId,
  providerFailure: string | null,
): void {
  setUpdateEverythingRun(
    (run) =>
      run &&
      closeFinishedUpdateRun({
        ...run,
        machines: run.machines.map((machine) =>
          machine.environmentId === environmentId
            ? {
                ...machine,
                server: null,
                result: providerFailure === null ? "done" : "failed",
                failure: providerFailure,
                providerFailure,
              }
            : machine,
        ),
      }),
  );
}

/** Drops a pass's settled record of a server, once the card updates that server itself. */
export function forgetUpdateRunServer(environmentId: EnvironmentId): void {
  setUpdateEverythingRun(
    (run) =>
      run &&
      closeFinishedUpdateRun({
        ...run,
        machines: run.machines.filter(
          (machine) => machine.environmentId !== environmentId || machine.result === null,
        ),
      }),
  );
}
