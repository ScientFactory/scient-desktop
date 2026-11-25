// @effect-diagnostics globalDate:off -- Promise-based store code with ISO timestamps.
import {
  LITERATURE_WATCH_FEATURED_ITEMS,
  LITERATURE_WATCH_SERVICES,
  type LiteratureWatch,
  triageLiteratureWatchItem,
} from "@scientfactory/scient-sources";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import {
  changeLiteratureWatch,
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
import { literatureWatchItemEntry } from "./LiteratureWatchOperations.ts";

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

export async function literatureWatchList(library: ScientLibraryLocation) {
  const { watches } = await listLiteratureWatches(library);
  const summaries = watches.map(summary);
  return {
    watches: summaries,
    unread: summaries.reduce((count, entry) => count + entry.unread, 0),
  };
}

export async function literatureWatchView(library: ScientLibraryLocation, watchId: string) {
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
export async function changeLiteratureWatchItem(
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

export async function setLiteratureWatchPaused(
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
