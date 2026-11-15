import type { ProviderAdapterV2BackgroundTaskSummary } from "./ProviderAdapter.ts";

/** Finished task ids an adapter remembers, so a late registration reads as finished. */
const SETTLED_BACKGROUND_TASK_LIMIT = 64;
/** Running tasks a refused registration names. */
const BACKGROUND_WAIT_RUNNING_LIMIT = 5;
const DESCRIPTION_LIMIT = 80;

/** Remembers a finished task under its owner, dropping the oldest past the limit. */
export function rememberSettledBackgroundTask<Owner>(
  settled: Map<string, Owner>,
  taskId: string,
  owner: Owner,
): void {
  settled.delete(taskId);
  settled.set(taskId, owner);
  for (const oldest of settled.keys()) {
    if (settled.size <= SETTLED_BACKGROUND_TASK_LIMIT) break;
    settled.delete(oldest);
  }
}

/** The task's own description, bounded, for an agent that lost track of the id it started. */
export function backgroundTaskSummary(
  taskId: string,
  description: string | undefined,
): ProviderAdapterV2BackgroundTaskSummary {
  const text = description?.replace(/\s+/gu, " ").trim();
  if (text === undefined || text === "") return { taskId };
  return {
    taskId,
    description:
      text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text,
  };
}

/**
 * Sorts a registration request: ids still running are matched, ids this thread already
 * finished are settled, and when neither applies the running unawaited tasks are listed.
 * Empty `settled` and `running` are left out.
 */
export function classifyBackgroundWait(input: {
  readonly taskIds: ReadonlyArray<string>;
  readonly isRunning: (taskId: string) => boolean;
  readonly isSettled: (taskId: string) => boolean;
  readonly unawaited: () => ReadonlyArray<ProviderAdapterV2BackgroundTaskSummary>;
}): {
  readonly matched: ReadonlyArray<string>;
  readonly settled?: ReadonlyArray<string>;
  readonly running?: ReadonlyArray<ProviderAdapterV2BackgroundTaskSummary>;
} {
  const unique = [...new Set(input.taskIds)];
  const matched = unique.filter(input.isRunning);
  const settled = unique.filter((taskId) => !input.isRunning(taskId) && input.isSettled(taskId));
  if (settled.length > 0) return { matched, settled };
  if (matched.length > 0) return { matched };
  const running = input.unawaited().slice(0, BACKGROUND_WAIT_RUNNING_LIMIT);
  return running.length === 0 ? { matched } : { matched, running };
}

/** What a refused registration adds so the agent can retry with a real id. */
export function runningBackgroundTasksHint(
  running: ReadonlyArray<ProviderAdapterV2BackgroundTaskSummary>,
): string {
  if (running.length === 0) return "";
  const listed = running
    .map((task) =>
      task.description === undefined
        ? `\`${task.taskId}\``
        : `\`${task.taskId}\` (${task.description})`,
    )
    .join(", ");
  return ` Running and not yet awaited here: ${listed}. Call again with one of these IDs.`;
}
