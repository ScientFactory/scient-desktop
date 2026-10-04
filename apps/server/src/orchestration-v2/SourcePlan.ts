import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";

/** Status and consumption change at acceptance; the selected plan content does not. */
export const sourcePlanFingerprint = (
  plan: Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>,
): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([plan.id, plan.threadId, plan.runId, plan.nodeId, plan.markdown]))
    .digest("hex");
