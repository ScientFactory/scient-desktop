import type { EnvironmentId } from "@t3tools/contracts";

import type { ServerUpdateOutcome, ServerUpdateTarget } from "~/components/ServerUpdateAction";
import {
  closeFinishedUpdateRun,
  currentConfirmedServerTargets,
} from "~/components/sidebar/updateEverything.logic";
import {
  setUpdateEverythingRun,
  settleUpdateRunMachine,
} from "~/components/sidebar/updateEverythingRun";

type ServerUpdate = (
  target: ServerUpdateTarget,
  options: { readonly quiet: boolean },
) => Promise<ServerUpdateOutcome>;

/**
 * Retries one server a pass failed or withdrew. Like the pass's own retry, it keeps the
 * confirmed version and mechanism, takes the current flags, and sends nothing unless that
 * target is qualified now. Returns whether it started.
 */
export function retryUpdateRunServer(
  environmentId: EnvironmentId,
  qualified: ReadonlyArray<ServerUpdateTarget>,
  update: ServerUpdate,
): boolean {
  const found: { retry?: { target: ServerUpdateTarget; providerFailure: string | null } } = {};
  setUpdateEverythingRun((run) => {
    const machine = run?.machines.find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.result === "failed" &&
        candidate.server !== null,
    );
    const target = machine?.server && currentConfirmedServerTargets([machine.server], qualified)[0];
    if (!run || !machine || !target) return run;
    found.retry = { target, providerFailure: machine.providerFailure };
    const startedAt = Date.now();
    return {
      ...run,
      machines: run.machines.map((candidate) =>
        candidate === machine
          ? { ...candidate, result: null, failure: null, startedAt }
          : candidate,
      ),
    };
  });
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
