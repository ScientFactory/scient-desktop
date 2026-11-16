// @effect-diagnostics nodeBuiltinImport:off -- a synchronous hash inside a pure event mapper.
import * as NodeCrypto from "node:crypto";

/**
 * Joins one run's analytics events (its outcome, its request totals) without sending its id: a
 * one-way hash of a random local id, so the reports cannot be traced back to a thread.
 */
export function analyticsRunRef(runId: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`scient-analytics-run:${runId}`)
    .digest("hex")
    .slice(0, 16);
}
