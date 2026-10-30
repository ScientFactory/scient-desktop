import type { ComputeExecutionRecord, ComputeSessionRecord } from "@t3tools/contracts";

export type ComputeFeedEntry =
  | {
      readonly kind: "run";
      readonly key: string;
      readonly session: ComputeSessionRecord;
      readonly execution: ComputeExecutionRecord;
    }
  /** A Run fresh session; its own executions are read where it is shown. */
  | { readonly kind: "fresh"; readonly key: string; readonly session: ComputeSessionRecord }
  | { readonly kind: "restart"; readonly key: string };

function byTime(left: { at: string; id: string }, right: { at: string; id: string }) {
  return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}

/**
 * One session's runs, oldest first, with fresh runs interleaved by start time. A restart keeps
 * history and marks a divider where the session's generation changed, including after the last run.
 */
export function computeFeedEntries(input: {
  readonly session: ComputeSessionRecord;
  readonly executions: ReadonlyArray<ComputeExecutionRecord>;
  readonly freshSessions: ReadonlyArray<ComputeSessionRecord>;
}): ReadonlyArray<ComputeFeedEntry> {
  const items = [
    ...input.executions.map((execution) => ({
      at: execution.request.submittedAt,
      id: execution.request.executionId,
      entry: {
        kind: "run",
        key: execution.request.executionId,
        session: input.session,
        execution,
      } satisfies ComputeFeedEntry,
    })),
    ...input.freshSessions.map((session) => ({
      at: session.createdAt,
      id: session.sessionId,
      entry: { kind: "fresh", key: session.sessionId, session } satisfies ComputeFeedEntry,
    })),
  ].toSorted(byTime);

  const entries: ComputeFeedEntry[] = [];
  let generation: number | null = null;
  for (const { entry } of items) {
    if (entry.kind === "run") {
      const next = entry.execution.request.generation;
      if (generation !== null && next > generation) {
        entries.push({ kind: "restart", key: `restart:${next}` });
      }
      generation = next;
    }
    entries.push(entry);
  }
  if (generation !== null && input.session.generation > generation) {
    entries.push({ kind: "restart", key: `restart:${input.session.generation}` });
  }
  return entries;
}
