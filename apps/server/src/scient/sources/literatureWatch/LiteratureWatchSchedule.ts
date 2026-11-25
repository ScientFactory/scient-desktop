import type { LiteratureWatch } from "@scientfactory/scient-sources";
import {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";

/** The thread settings a watch's scheduled runs use, taken from the thread that set it up. */
export const LiteratureWatchRunner = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type LiteratureWatchRunner = typeof LiteratureWatchRunner.Type;
const decodeRunner = Schema.decodeUnknownOption(LiteratureWatchRunner);

const DAY_MS = 24 * 60 * 60 * 1000;

/** One task per watch, named after it, so a lost task is rebuilt rather than duplicated. */
export const literatureWatchTaskId = (watchId: string) =>
  ScheduledTaskId.make(`scheduled-task:${watchId}`);

export function literatureWatchPrompt(watch: Pick<LiteratureWatch, "watchId" | "title">): string {
  return `Run the literature watch "${watch.title}" (${watch.watchId}) with the literature-watch skill: scient_watch_run, screen, then scient_watch_publish.`;
}

/**
 * Writes the watch's task as the watch says: title, cadence, paused or not. Its runs share one
 * thread, each with a fresh session. Unchanged schedules keep their next run.
 */
export const syncLiteratureWatchSchedule = Effect.fn("LiteratureWatch.syncSchedule")(function* (
  watch: LiteratureWatch,
) {
  const runner = decodeRunner(watch.runner);
  if (Option.isNone(runner)) return null;
  const tasks = yield* ScheduledTaskService;
  const id = literatureWatchTaskId(watch.watchId);
  const bound = (yield* tasks.list()).tasks.find((task) => task.id === id)?.threadId ?? null;
  // An archived or deleted run thread refuses scheduled messages; the next run starts a new one.
  const shell =
    bound === null
      ? null
      : yield* (yield* ProjectionStoreV2)
          .getThreadShell(bound)
          .pipe(Effect.orElseSucceed(() => null));
  const unbindThread = bound !== null && (shell === null || shell.archivedAt !== null);
  const { task } = yield* tasks.upsert({
    id,
    ...(unbindThread ? { unbindThread: true } : {}),
    title: `Literature watch: ${watch.title}`.slice(0, 200),
    prompt: literatureWatchPrompt(watch),
    enabled: watch.paused !== true,
    schedule: { type: "interval", everyMs: watch.everyDays * DAY_MS },
    projectId: runner.value.projectId,
    threadMode: "fresh_session",
    workspaceStrategy: { type: "root" },
    modelSelection: runner.value.modelSelection,
    runtimeMode: runner.value.runtimeMode,
    interactionMode: runner.value.interactionMode,
    createdBy: "agent",
    creationSource: "mcp",
  });
  return task;
});

/** Rewrites each watch's task, rebuilding one that was lost and rebinding an archived thread. */
export const restoreLiteratureWatchSchedules = Effect.fn("LiteratureWatch.restoreSchedules")(
  function* (watches: ReadonlyArray<LiteratureWatch>) {
    for (const watch of watches) yield* syncLiteratureWatchSchedule(watch);
  },
);

export const runLiteratureWatchNow = Effect.fn("LiteratureWatch.runNow")(function* (
  watchId: string,
) {
  const tasks = yield* ScheduledTaskService;
  const { threadId } = yield* tasks.runNow({ id: literatureWatchTaskId(watchId) });
  return threadId !== null;
});

export const deleteLiteratureWatchSchedule = Effect.fn("LiteratureWatch.deleteSchedule")(function* (
  watchId: string,
) {
  const tasks = yield* ScheduledTaskService;
  yield* tasks.delete({ id: literatureWatchTaskId(watchId) }).pipe(Effect.ignore);
});
