/** The server no longer stands by the plan it was asked to start. */
export function isRuntimePlanStale(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "runtime_plan_stale"
  );
}
