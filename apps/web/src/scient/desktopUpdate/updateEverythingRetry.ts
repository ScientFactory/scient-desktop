import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import {
  currentConfirmedServerTargets,
  type UpdateCapsuleView,
  type UpdateRunMachine,
} from "~/components/sidebar/updateEverything.logic";

/**
 * Offers Retry only while a failed server's confirmed version and mechanism are qualified
 * now, as the retry itself rechecks; otherwise Dismiss. A withdrawn server keeps its
 * confirmed target, so Retry returns once that target is eligible again.
 */
export function offerEligibleUpdateRetry(
  view: UpdateCapsuleView,
  machines: ReadonlyArray<UpdateRunMachine>,
  qualified: ReadonlyArray<ServerUpdateTarget>,
): UpdateCapsuleView {
  if (view.action !== "retry") return view;
  const failed = machines.flatMap((machine) =>
    machine.result === "failed" && machine.server !== null ? [machine.server] : [],
  );
  return currentConfirmedServerTargets(failed, qualified).length === 0
    ? { ...view, action: "dismiss" }
    : view;
}
