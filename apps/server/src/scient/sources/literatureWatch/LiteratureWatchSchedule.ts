import type { LiteratureWatch } from "@scientfactory/scient-sources";
import {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  type ScheduledTask,
  ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { listLiteratureWatches } from "@scientfactory/scient-sources/literature-watch-store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../../config.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../../serverActivation.ts";
import { ScientSourcesBackend } from "../SourcesBackend.ts";

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

/** Whether a watch's task needs writing: it was lost, or its run thread is archived or gone. */
const needsRestore = Effect.fn("LiteratureWatch.needsRestore")(function* (
  task: { readonly threadId: ThreadId | null } | undefined,
) {
  if (!task) return true;
  if (task.threadId === null) return false;
  const shell = yield* (yield* ProjectionStoreV2)
    .getThreadShell(task.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  return shell === null || shell.archivedAt !== null;
});

/** Rebuilds the task of a watch that lost it and rebinds one whose run thread was archived. */
export const restoreLiteratureWatchSchedules = Effect.fn("LiteratureWatch.restoreSchedules")(
  function* (watches: ReadonlyArray<LiteratureWatch>) {
    const { tasks } = yield* (yield* ScheduledTaskService).list();
    for (const watch of watches) {
      const task = tasks.find((entry) => entry.id === literatureWatchTaskId(watch.watchId));
      if (yield* needsRestore(task)) yield* syncLiteratureWatchSchedule(watch);
    }
  },
);

/** A scheduled run that ended without a briefing, so the watch can say so and offer Run now. */
export function literatureWatchRunUnfinished(
  watch: Pick<LiteratureWatch, "briefings">,
  task: Pick<ScheduledTask, "lastRunAt" | "lastRunStatus"> | undefined,
): boolean {
  if (!task?.lastRunAt || task.lastRunStatus === "running") return false;
  const published = watch.briefings[0]?.publishedAt;
  return !published || published < task.lastRunAt;
}

/** Restores lost schedules soon after start and every few hours, while Scient is open. */
export const literatureWatchSchedulePassLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* ScientSourcesBackend) !== "library") return;
    const config = yield* ServerConfig;
    const library = scientLibraryLocation(scientLibraryRootFor(config.stateDir));
    const pass = Effect.promise(() =>
      listLiteratureWatches(library).catch(() => ({ watches: [] })),
    ).pipe(
      Effect.flatMap(({ watches }) => restoreLiteratureWatchSchedules(watches)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Literature watch schedules were not restored.", { cause }),
      ),
    );
    yield* forkParked(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced("6 hours")))),
      ),
    );
  }),
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
