import {
  LiteratureWatchPublishError,
  literatureWatchRecentTriage,
  retuneLiteratureWatch,
  type LiteratureWatch,
  type LiteratureWatchDefinition,
} from "@scientfactory/scient-sources";
import {
  changeLiteratureWatch,
  createLiteratureWatch,
  listLiteratureWatches,
  LiteratureWatchNotFoundError,
  readLiteratureWatch,
  readLiteratureWatchRun,
} from "@scientfactory/scient-sources/literature-watch-store";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  LiteratureWatchRunError,
  literatureWatchAbstracts,
  literatureWatchTitles,
  publishLiteratureWatch,
  startLiteratureWatchRun,
} from "../../../scient/sources/literatureWatch/LiteratureWatchOperations.ts";
import {
  runLiteratureWatchNow,
  syncLiteratureWatchSchedule,
} from "../../../scient/sources/literatureWatch/LiteratureWatchSchedule.ts";
import { requestMetadata } from "../../../scient/sources/metadataHttp.ts";
import { readResearchKeys } from "../../../scient/sources/researchKeys.ts";
import { resolveWholeLibrary } from "../sources/handlers.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";
import { ScientLiteratureWatchToolkit } from "./tools.ts";

const fail = (code: ScientSourcesToolError["code"], message: string) =>
  new ScientSourcesToolError({ code, message });

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // Store errors can name host paths; only the watch's own messages reach the agent.
    catch: (error) =>
      error instanceof LiteratureWatchNotFoundError
        ? fail("not-found", error.message)
        : error instanceof LiteratureWatchPublishError ||
            error instanceof LiteratureWatchRunError ||
            (error instanceof Error && error.message.startsWith("That run"))
          ? fail("operation-failed", error.message)
          : fail("operation-failed", "The literature watch operation could not be completed."),
  });

function summary(watch: LiteratureWatch) {
  const last = watch.briefings[0];
  return {
    watchId: watch.watchId,
    title: watch.title,
    everyDays: watch.everyDays,
    paused: watch.paused === true,
    ...(last ? { lastBriefingAt: last.publishedAt } : {}),
    briefings: watch.briefings.length,
  };
}

const readWatches = Effect.fn("LiteratureWatchToolkit.read")(function* (input: {
  readonly watchId?: string;
}) {
  const { library } = yield* resolveWholeLibrary("read");
  if (!input.watchId) {
    const { watches, issues } = yield* attempt(() => listLiteratureWatches(library));
    return { watches: watches.map(summary), ...(issues.length ? { issues } : {}) };
  }
  const watchId = input.watchId;
  const watch = yield* attempt(() => readLiteratureWatch(library, watchId));
  const open = yield* attempt(() => readLiteratureWatchRun(library, watchId));
  const last = watch.briefings[0];
  return {
    watch: {
      ...summary(watch),
      request: watch.request,
      ...(watch.details ? { details: watch.details } : {}),
      queries: watch.queries,
      covered: { ...watch.covered },
      ...(last ? { lastServices: last.services } : {}),
      recentTriage: literatureWatchRecentTriage(watch),
      ...(open ? { openRunId: open.runId } : {}),
    },
  };
});

/** The calling thread's project and settings, which the watch's scheduled runs reuse. */
const callerRunner = Effect.fn("LiteratureWatchToolkit.callerRunner")(function* () {
  const scope = yield* AgentInvocationContext.AgentInvocationContext;
  const shell = yield* (yield* ProjectionStoreV2)
    .getThreadShell(scope.threadId)
    .pipe(Effect.mapError(() => fail("operation-failed", "Could not read this thread.")));
  if (shell === null) return yield* fail("operation-failed", "Could not read this thread.");
  return {
    projectId: shell.projectId,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
  };
});

const scheduleFailure = () =>
  fail("operation-failed", "The watch was saved, but its schedule could not be set.");

const saveWatch = Effect.fn("LiteratureWatchToolkit.save")(function* (
  input: LiteratureWatchDefinition & { readonly watchId?: string; readonly paused?: boolean },
) {
  const { library } = yield* resolveWholeLibrary("write");
  const { watchId, paused, ...definition } = input;
  const now = DateTime.toDateUtc(yield* DateTime.now);
  if (watchId) {
    const watch = yield* attempt(() =>
      changeLiteratureWatch(library, watchId, (current) => {
        const { paused: _paused, details: _details, ...rest } = current;
        const next = {
          ...rest,
          ...definition,
          ...((paused ?? current.paused) ? { paused: true as const } : {}),
          updatedAt: now.toISOString(),
        };
        const retopic =
          current.request !== definition.request ||
          JSON.stringify(current.queries) !== JSON.stringify(definition.queries);
        return retopic
          ? retuneLiteratureWatch({ ...next, revision: (current.revision ?? 0) + 1 }, now)
          : next;
      }),
    );
    yield* syncLiteratureWatchSchedule(watch).pipe(Effect.mapError(scheduleFailure));
    return { watchId, created: false, firstRunStarted: false };
  }
  const runner = yield* callerRunner();
  const created = yield* attempt(() =>
    createLiteratureWatch(library, { ...definition }, "agent", now),
  );
  const watch = yield* attempt(() =>
    changeLiteratureWatch(library, created.watchId, (current) => ({
      ...current,
      runner,
      ...(paused ? { paused: true as const } : {}),
    })),
  );
  yield* syncLiteratureWatchSchedule(watch).pipe(Effect.mapError(scheduleFailure));
  const started = paused
    ? false
    : yield* runLiteratureWatchNow(watch.watchId).pipe(Effect.orElseSucceed(() => false));
  return { watchId: watch.watchId, created: true, firstRunStarted: started };
});

const runWatch = Effect.fn("LiteratureWatchToolkit.run")(function* (input: {
  readonly watchId: string;
  readonly runId?: string;
  readonly offset?: number;
  readonly abstractsFor?: ReadonlyArray<string>;
}) {
  const { library } = yield* resolveWholeLibrary("write");
  const keys = yield* readResearchKeys();
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const run = yield* attempt(() =>
    startLiteratureWatchRun(library, input.watchId, {
      request: requestMetadata,
      keys,
      now,
    }),
  );
  if (input.runId && input.runId !== run.runId) {
    return yield* fail(
      "operation-failed",
      `Run ${input.runId} is no longer open; this is a new run (${run.runId}). Start its titles from offset 0.`,
    );
  }
  const head = {
    runId: run.runId,
    services: run.services,
    candidates: run.candidates.length,
    alreadySeen: run.alreadySeen,
  };
  if (input.abstractsFor) {
    return { ...head, abstracts: literatureWatchAbstracts(run, input.abstractsFor) };
  }
  const page = yield* attempt(() => literatureWatchTitles(library, run, input.offset ?? 0));
  return { ...head, ...page };
});

const publishWatch = Effect.fn("LiteratureWatchToolkit.publish")(function* (input: {
  readonly watchId: string;
  readonly runId: string;
  readonly summary?: string;
  readonly picks: ReadonlyArray<{
    readonly candidateId: string;
    readonly why: string;
    readonly details: ReadonlyArray<string>;
    readonly evidence: "title" | "abstract" | "full-text";
  }>;
}) {
  const { library } = yield* resolveWholeLibrary("write");
  const picks = input.picks.map((pick) => ({
    ...pick,
    why: pick.why.trim(),
    details: pick.details.map((line) => line.trim()).filter(Boolean),
  }));
  const blank = picks.find((pick) => !pick.why);
  if (blank) return yield* fail("operation-failed", `${blank.candidateId} needs a why.`);
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const watch = yield* attempt(() =>
    publishLiteratureWatch(library, {
      watchId: input.watchId,
      runId: input.runId,
      picks,
      ...(input.summary ? { summary: input.summary } : {}),
      now,
    }),
  );
  const briefing = watch.briefings.find((entry) => entry.briefingId === input.runId);
  if (!briefing) return yield* fail("operation-failed", "The briefing could not be saved.");
  return {
    briefingId: briefing.briefingId,
    picks: briefing.items.length,
    screened: briefing.screened,
    ...(briefing.unscreened ? { unscreened: briefing.unscreened } : {}),
  };
});

export const ScientLiteratureWatchToolkitHandlersLive = ScientLiteratureWatchToolkit.toLayer(
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const tasks = yield* ScheduledTaskService;
    const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ProjectionStoreV2, projections),
        Effect.provideService(ScheduledTaskService, tasks),
      );
    return {
      scient_watches: readWatches,
      scient_watch_save: (input: Parameters<typeof saveWatch>[0]) => withServices(saveWatch(input)),
      scient_watch_run: runWatch,
      scient_watch_publish: publishWatch,
    };
  }),
);
