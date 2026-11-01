import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";

export type ThreadTaskList = Extract<ThreadStructure["plans"][number], { kind: "todo_list" }>;

/**
 * The list the tasks bar shows: the thread's latest one, while steps remain and the agent session
 * that wrote it is still the thread's. Another agent taking over would not know those tasks.
 */
export function selectThreadTaskList(
  projection: Pick<ThreadStructure, "plans" | "runs"> | null,
): ThreadTaskList | null {
  if (projection === null) return null;
  const runs = new Map(projection.runs.map((run) => [run.id, run]));

  let list: ThreadTaskList | null = null;
  let listOrdinal = -1;
  for (const plan of projection.plans) {
    const ordinal = plan.runId === null ? undefined : runs.get(plan.runId)?.ordinal;
    if (
      plan.kind === "todo_list" &&
      plan.status !== "superseded" &&
      ordinal !== undefined &&
      ordinal >= listOrdinal
    ) {
      list = plan;
      listOrdinal = ordinal;
    }
  }
  if (list === null || list.steps.every((step) => step.status === "completed")) return null;

  const latestSession = projection.runs
    .filter((run) => run.startedAt !== null && run.providerThreadId !== null)
    .reduce<ThreadStructure["runs"][number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    )?.providerThreadId;
  const listSession = list.runId === null ? undefined : runs.get(list.runId)?.providerThreadId;
  return listSession === latestSession ? list : null;
}
