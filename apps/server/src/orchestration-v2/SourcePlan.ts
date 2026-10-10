// @effect-diagnostics nodeBuiltinImport:off -- Pure admission guards compare stable persisted plan fingerprints synchronously.
import * as NodeCrypto from "node:crypto";
import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  PlanId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/** Status and consumption change at acceptance; the selected plan content does not. */
export const sourcePlanFingerprint = (
  plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>,
): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([plan.id, plan.threadId, plan.runId, plan.nodeId, plan.markdown]))
    .digest("hex");

/** A queued run may start from its proposed plan only while that plan is still active
 * (or already consumed by this run), unchanged, and in a live thread of the same project. */
export const queuedSourcePlanIsUsable = (input: {
  readonly plan: OrchestrationV2PlanArtifact | undefined;
  readonly ref: { readonly threadId: ThreadId; readonly planId: PlanId };
  readonly sourceThread: OrchestrationV2ThreadShell | null;
  readonly threadId: ThreadId;
  readonly queuedRun: OrchestrationV2Run;
  readonly projectId: ProjectId;
}): boolean => {
  const { plan, ref, sourceThread, queuedRun } = input;
  return !(
    plan?.kind !== "proposed_plan" ||
    plan.id !== ref.planId ||
    plan.threadId !== ref.threadId ||
    (plan.status !== "active" &&
      !(
        plan.status === "completed" &&
        plan.consumedBy?.threadId === input.threadId &&
        plan.consumedBy.runId === queuedRun.id
      )) ||
    (queuedRun.sourcePlanFingerprint !== undefined &&
      queuedRun.sourcePlanFingerprint !== sourcePlanFingerprint(plan)) ||
    sourceThread === null ||
    sourceThread.deletedAt !== null ||
    sourceThread.archivedAt !== null ||
    sourceThread.projectId !== input.projectId
  );
};
