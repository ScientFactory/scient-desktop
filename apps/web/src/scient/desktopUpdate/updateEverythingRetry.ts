import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import {
  currentConfirmedServerTargets,
  type UpdateCapsuleView,
  type UpdateRunMachineView,
} from "~/components/sidebar/updateEverything.logic";

/**
 * Offers Retry only while a failed server's confirmed target, or the one rebuilt for a row
 * restored after a relaunch, is qualified now; otherwise Dismiss. A restored server already on
 * its target keeps Retry, which settles it without an update.
 */
export function offerEligibleUpdateRetry(
  view: UpdateCapsuleView,
  machines: ReadonlyArray<UpdateRunMachineView>,
  qualified: ReadonlyArray<ServerUpdateTarget>,
): UpdateCapsuleView {
  if (view.action !== "retry") return view;
  const failed = machines.flatMap(({ machine, restoredRetry }) =>
    machine.result === "failed" ? [machine.server ?? restoredRetry] : [],
  );
  const settles = failed.includes("current");
  const targets = failed.flatMap((target) =>
    target === null || target === "current" ? [] : [target],
  );
  return settles || currentConfirmedServerTargets(targets, qualified).length > 0
    ? view
    : { ...view, action: "dismiss" };
}
