// @effect-diagnostics globalDate:off -- Promise-based store code with ISO timestamps.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  LITERATURE_WATCH_FEATURED_ITEMS,
  LITERATURE_WATCH_SERVICES,
  type LiteratureWatch,
  triageLiteratureWatchItem,
} from "@scientfactory/scient-sources";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import {
  changeLiteratureWatch,
  deleteLiteratureWatch,
  listLiteratureWatches,
  readLiteratureWatch,
} from "@scientfactory/scient-sources/literature-watch-store";
import type {
  ScientLiteratureWatchChange,
  ScientLiteratureWatchChangeResult,
  ScientLiteratureWatchSummary,
} from "@t3tools/contracts";

import {
  addScientSourcesByIdentifier,
  type ResolveSourceIdentifierBatch,
} from "../SourceIdentifierAdd.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { literatureWatchItemEntry } from "./LiteratureWatchOperations.ts";
import {
  deleteLiteratureWatchSchedule,
  literatureWatchRunStatus,
  literatureWatchTaskId,
  runLiteratureWatchNow,
  syncLiteratureWatchSchedule,
} from "./LiteratureWatchSchedule.ts";

export class LiteratureWatchOperationError extends Schema.TaggedError<LiteratureWatchOperationError>()(
  "LiteratureWatchOperationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LiteratureWatchOperationError({ message: "The watch could not be changed.", cause }),
  });

function unread(watch: LiteratureWatch): number {
  return watch.briefings
    .filter((briefing) => !briefing.openedAt)
    .reduce(
      (count, briefing) => count + Math.min(briefing.items.length, LITERATURE_WATCH_FEATURED_ITEMS),
      0,
    );
}

function summary(watch: LiteratureWatch): ScientLiteratureWatchSummary {
  const last = watch.briefings[0];
  return {
    watchId: watch.watchId,
    title: watch.title,
    everyDays: watch.everyDays,
    paused: watch.paused === true,
    ...(last ? { lastBriefingAt: last.publishedAt } : {}),
    unread: unread(watch),
  };
}

async function literatureWatchList(library: ScientLibraryLocation) {
  const { watches } = await listLiteratureWatches(library);
  const summaries = watches.map(summary);
  return {
    watches: summaries,
    unread: summaries.reduce((count, entry) => count + entry.unread, 0),
    all: watches,
  };
}

async function literatureWatchView(library: ScientLibraryLocation, watchId: string) {
  const watch = await readLiteratureWatch(library, watchId);
  return {
    watch,
    view: {
      ...summary(watch),
      request: watch.request,
      ...(watch.details ? { details: watch.details } : {}),
      services: LITERATURE_WATCH_SERVICES.filter((service) => watch.queries[service]),
      briefings: watch.briefings,
    },
  };
}

type ItemChange = Extract<ScientLiteratureWatchChange, { readonly candidateId: string }>;

/** Keep, dismiss, clear, note or mark opened: what the person did with a briefing. */
async function changeLiteratureWatchItem(
  library: ScientLibraryLocation,
  watchId: string,
  change: ItemChange | Extract<ScientLiteratureWatchChange, { readonly action: "opened" }>,
  resolveIdentifiers: ResolveSourceIdentifierBatch,
  now: Date,
): Promise<ScientLiteratureWatchChangeResult> {
  if (change.action === "opened") {
    await changeLiteratureWatch(library, watchId, (watch) => ({
      ...watch,
      briefings: watch.briefings.map((briefing) =>
        briefing.briefingId === change.briefingId && !briefing.openedAt
          ? { ...briefing, openedAt: now.toISOString() }
          : briefing,
      ),
    }));
    return {};
  }
  const target = { briefingId: change.briefingId, candidateId: change.candidateId };
  if (change.action === "keep") {
    const watch = await readLiteratureWatch(library, watchId);
    const item = watch.briefings
      .find((briefing) => briefing.briefingId === change.briefingId)
      ?.items.find((entry) => entry.candidate.candidateId === change.candidateId);
    const entry = item ? literatureWatchItemEntry(item.candidate) : null;
    if (!entry) return { kept: { outcome: "not-found" } };
    const [added] = await addScientSourcesByIdentifier({
      root: library,
      entries: [entry],
      actor: "user",
      enrich: true,
      resolveIdentifiers,
    });
    const sourceId = added?.sourceId ?? null;
    if (!added || !sourceId || (added.outcome !== "imported" && added.outcome !== "duplicate")) {
      return {
        kept: { outcome: added?.outcome === "identifier-not-found" ? "not-found" : "unavailable" },
      };
    }
    await changeLiteratureWatch(library, watchId, (current) =>
      triageLiteratureWatchItem(
        current,
        target,
        { triage: { action: "kept", at: now.toISOString(), by: "user", sourceId } },
        now,
      ),
    );
    return { kept: { outcome: added.outcome, sourceId } };
  }
  await changeLiteratureWatch(library, watchId, (watch) =>
    triageLiteratureWatchItem(
      watch,
      target,
      change.action === "note"
        ? { note: change.note.trim() || null }
        : {
            triage:
              change.action === "dismiss"
                ? { action: "dismissed", at: now.toISOString(), by: "user" }
                : null,
          },
      now,
    ),
  );
  return {};
}

async function setLiteratureWatchPaused(
  library: ScientLibraryLocation,
  watchId: string,
  paused: boolean,
  now: Date,
): Promise<LiteratureWatch> {
  return changeLiteratureWatch(library, watchId, (watch) => {
    const { paused: _paused, ...rest } = watch;
    return { ...rest, ...(paused ? { paused: true as const } : {}), updatedAt: now.toISOString() };
  });
}

const watchTasks = Effect.fn("LiteratureWatch.tasks")(function* () {
  const { tasks } = yield* (yield* ScheduledTaskService)
    .list()
    .pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
  return (watchId: string) => tasks.find((task) => task.id === literatureWatchTaskId(watchId));
});

/** The Library's watches with their unread counts and run status. Reads change nothing. */
export const listLibraryLiteratureWatches = Effect.fn("LiteratureWatch.listForLibrary")(function* (
  library: ScientLibraryLocation,
) {
  const listed = yield* attempt(() => literatureWatchList(library));
  const taskOf = yield* watchTasks();
  const watches = yield* Effect.forEach(listed.watches, (summary, index) =>
    literatureWatchRunStatus(listed.all[index]!, taskOf(summary.watchId)).pipe(
      Effect.map((status) => ({
        ...summary,
        paused: status.paused,
        ...(status.unfinished ? { unfinished: true } : {}),
      })),
    ),
  );
  return { unread: listed.unread, watches };
});

/** One watch with its briefings and run status. Reads change nothing. */
export const readLibraryLiteratureWatch = Effect.fn("LiteratureWatch.readForLibrary")(function* (
  library: ScientLibraryLocation,
  watchId: string,
) {
  const { watch, view } = yield* attempt(() => literatureWatchView(library, watchId));
  const task = (yield* watchTasks())(watchId);
  const status = yield* literatureWatchRunStatus(watch, task);
  return {
    watch: {
      ...view,
      ...(task?.threadId ? { threadId: task.threadId } : {}),
      running: status.running,
      paused: status.paused,
      ...(status.unfinished ? { unfinished: true } : {}),
    },
  };
});

/** What the person does from Watches: triage, pause or resume, run now, delete. */
export const changeLibraryLiteratureWatch = Effect.fn("LiteratureWatch.changeFromLibrary")(
  function* (
    library: ScientLibraryLocation,
    watchId: string,
    change: ScientLiteratureWatchChange,
    resolveIdentifiers: ResolveSourceIdentifierBatch,
  ) {
    const now = DateTime.toDateUtc(yield* DateTime.now);
    switch (change.action) {
      case "pause":
      case "resume": {
        const watch = yield* attempt(() =>
          setLiteratureWatchPaused(library, watchId, change.action === "pause", now),
        );
        yield* syncLiteratureWatchSchedule(watch);
        return {};
      }
      case "delete":
        yield* attempt(() => deleteLiteratureWatch(library, watchId));
        yield* deleteLiteratureWatchSchedule(watchId);
        return {};
      case "run-now": {
        const watch = yield* attempt(() => readLiteratureWatch(library, watchId));
        yield* syncLiteratureWatchSchedule(watch);
        if (!(yield* runLiteratureWatchNow(watchId))) {
          return yield* new LiteratureWatchOperationError({ message: "The run did not start." });
        }
        return {};
      }
      default:
        return yield* attempt(() =>
          changeLiteratureWatchItem(library, watchId, change, resolveIdentifiers, now),
        );
    }
  },
);
