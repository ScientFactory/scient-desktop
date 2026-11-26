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
  type ScientLibraryLocation,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  changeLiteratureWatch,
  listLiteratureWatches,
  readLiteratureWatch,
} from "@scientfactory/scient-sources/literature-watch-store";
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
const TASK_ID_PREFIX = "scheduled-task:";
const WATCH_TASK_PREFIX = `${TASK_ID_PREFIX}watch-`;
export const literatureWatchTaskId = (watchId: string) =>
  ScheduledTaskId.make(`${TASK_ID_PREFIX}${watchId}`);

function literatureWatchPrompt(watch: Pick<LiteratureWatch, "watchId" | "title">): string {
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

/** Writes the watch's task only when it is missing or bound to an archived or deleted thread. */
export const ensureLiteratureWatchSchedule = Effect.fn("LiteratureWatch.ensureSchedule")(function* (
  watch: LiteratureWatch,
) {
  const { tasks } = yield* (yield* ScheduledTaskService).list();
  const task = tasks.find((entry) => entry.id === literatureWatchTaskId(watch.watchId));
  if (yield* needsRestore(task)) yield* syncLiteratureWatchSchedule(watch);
});

const watchExists = (library: ScientLibraryLocation, watchId: string) =>
  Effect.promise(() =>
    readLiteratureWatch(library, watchId).then(
      () => true,
      () => false,
    ),
  );

/**
 * Brings tasks and watches together: rebuilds a lost task, rebinds one whose run thread was
 * archived, takes on a pause or resume made in Scheduled tasks, and removes tasks whose watch is
 * gone. Each watch is read again just before anything is written, so a delete or edit wins.
 */
const restoreLiteratureWatchSchedules = Effect.fn("LiteratureWatch.restoreSchedules")(function* (
  library: ScientLibraryLocation,
) {
  const listed = yield* Effect.promise(() => listLiteratureWatches(library).catch(() => null));
  if (!listed) return;
  const scheduler = yield* ScheduledTaskService;
  const { tasks } = yield* scheduler.list();
  const owned = new Set(listed.watches.map((watch) => literatureWatchTaskId(watch.watchId)));
  // A watch file that could not be read still owns its task.
  if (listed.issues.length === 0) {
    for (const task of tasks) {
      if (!task.id.startsWith(WATCH_TASK_PREFIX) || owned.has(task.id)) continue;
      // A watch created since the listing owns its task too.
      if (yield* watchExists(library, task.id.slice(TASK_ID_PREFIX.length))) continue;
      yield* scheduler.delete({ id: task.id }).pipe(Effect.ignore);
    }
  }
  for (const { watchId } of listed.watches) {
    const task = tasks.find((entry) => entry.id === literatureWatchTaskId(watchId));
    const current = yield* Effect.promise(() =>
      readLiteratureWatch(library, watchId).catch(() => null),
    );
    if (!current) continue;
    if (task && task.enabled === (current.paused === true)) {
      const paused = !task.enabled;
      yield* Effect.promise(() =>
        changeLiteratureWatch(library, watchId, (watch) => {
          const { paused: _paused, ...rest } = watch;
          return paused ? { ...rest, paused: true as const } : rest;
        }),
      ).pipe(Effect.ignore);
      continue;
    }
    if (yield* needsRestore(task)) yield* syncLiteratureWatchSchedule(current);
  }
});

/**
 * Where the watch's runs stand. The task reports a run done once its prompt is sent, so a run
 * counts as going while its thread is working, and unfinished only when it stopped unpublished.
 * A task turned off in Scheduled tasks is a paused watch.
 */
export const literatureWatchRunStatus = Effect.fn("LiteratureWatch.runStatus")(function* (
  watch: LiteratureWatch,
  task: ScheduledTask | undefined,
) {
  // The task's switch is the schedule; Scheduled tasks can flip it, and the pass follows it.
  const paused = task ? !task.enabled : watch.paused === true;
  if (!task) return { running: false, unfinished: false, paused };
  const shell =
    task.threadId === null
      ? null
      : yield* (yield* ProjectionStoreV2)
          .getThreadShell(task.threadId)
          .pipe(Effect.orElseSucceed(() => null));
  const running = task.lastRunStatus === "running" || (shell?.activeRunId ?? null) !== null;
  return { running, unfinished: !running && literatureWatchRunUnfinished(watch, task), paused };
});

function literatureWatchRunUnfinished(
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
    const pass = restoreLiteratureWatchSchedules(library).pipe(
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
