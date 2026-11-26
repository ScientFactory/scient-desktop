// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- Promise-based store code with ISO timestamps and run IDs.
import * as NodeCrypto from "node:crypto";

import {
  LITERATURE_WATCH_SERVICES,
  LiteratureWatchCandidate,
  type LiteratureWatch,
  type LiteratureWatchPick,
  type LiteratureWatchRun,
  literatureWatchCandidates,
  literatureWatchWindow,
  publishLiteratureWatchRun,
} from "@scientfactory/scient-sources";
import {
  changeLiteratureWatchRun,
  claimLiteratureWatchRun,
  finishLiteratureWatchRun,
  readLiteratureWatch,
  resumableLiteratureWatchRun,
} from "@scientfactory/scient-sources/literature-watch-store";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import * as Schema from "effect/Schema";

import { searchWatchService, type WatchSearchOptions } from "./watchSearch.ts";

export const WATCH_TITLES_PAGE = 500;
const isCandidate = Schema.is(LiteratureWatchCandidate);
/** Long enough for any structured abstract, short enough that 30 fit one answer. */
const ABSTRACT_SHOWN = 3_000;

// @effect-diagnostics-next-line extendsNativeError:off - The watch store is Promise-based; handlers catch native errors.
export class LiteratureWatchRunError extends Error {}

/** Resumes the watch's open run, or fetches every service's window into a new one. */
export async function startLiteratureWatchRun(
  library: ScientLibraryLocation,
  watchId: string,
  options: WatchSearchOptions & { readonly now: Date },
): Promise<LiteratureWatchRun> {
  const open = await resumableLiteratureWatchRun(library, watchId, options.now);
  if (open) return open;
  const watch = await readLiteratureWatch(library, watchId);
  const results = await Promise.all(
    LITERATURE_WATCH_SERVICES.flatMap((service) => {
      const query = watch.queries[service];
      return query
        ? [
            searchWatchService(
              service,
              query,
              literatureWatchWindow(watch, service, options.now),
              options,
            ),
          ]
        : [];
    }),
  );
  const { candidates: merged, alreadySeen } = literatureWatchCandidates(
    results.flatMap((result) => result.found),
    watch.seen,
  );
  // One malformed record must not make the whole run unreadable.
  const candidates = merged.filter(isCandidate);
  const run: LiteratureWatchRun = {
    formatVersion: 1,
    watchId,
    runId: `run-${options.now.toISOString().slice(0, 10)}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    startedAt: options.now.toISOString(),
    services: results.map((result) => result.run),
    alreadySeen,
    candidates,
    delivered: 0,
  };
  return claimLiteratureWatchRun(library, run, options.now);
}

/** A compact line per candidate, for title screening. */
function titleLine(candidate: LiteratureWatchCandidate) {
  return {
    id: candidate.candidateId,
    title: candidate.title,
    ...(candidate.venue ? { venue: candidate.venue } : {}),
    ...(candidate.published ? { published: candidate.published } : {}),
    ...(candidate.kinds?.length ? { kinds: candidate.kinds.slice(0, 3) } : {}),
    ...(candidate.abstract ? {} : { noAbstract: true as const }),
  };
}

/** Titles from `offset`; what is handed out counts as screened when the run is published. */
export async function literatureWatchTitles(
  library: ScientLibraryLocation,
  run: LiteratureWatchRun,
  offset: number,
) {
  // Pages are read in order, so a title counts as screened only once it was handed out.
  if (offset > run.delivered) {
    throw new LiteratureWatchRunError(`Read the titles from offset ${run.delivered} first.`);
  }
  const page = run.candidates.slice(offset, offset + WATCH_TITLES_PAGE);
  const end = offset + page.length;
  if (end > run.delivered) {
    await changeLiteratureWatchRun(library, run.watchId, run.runId, (current) => ({
      ...current,
      delivered: Math.max(current.delivered, end),
    }));
  }
  return {
    titles: page.map(titleLine),
    allTitlesRead: end >= run.candidates.length,
    ...(end < run.candidates.length ? { nextOffset: end } : {}),
  };
}

/** Full records for candidates already handed out. */
export function literatureWatchAbstracts(
  run: LiteratureWatchRun,
  candidateIds: ReadonlyArray<string>,
): ReadonlyArray<LiteratureWatchCandidate> {
  const wanted = new Set(candidateIds);
  return run.candidates
    .slice(0, run.delivered)
    .filter((candidate) => wanted.has(candidate.candidateId))
    .map((candidate) =>
      candidate.abstract && candidate.abstract.length > ABSTRACT_SHOWN
        ? { ...candidate, abstract: `${candidate.abstract.slice(0, ABSTRACT_SHOWN)}…` }
        : candidate,
    );
}

export function publishLiteratureWatch(
  library: ScientLibraryLocation,
  input: {
    readonly watchId: string;
    readonly runId: string;
    readonly picks: ReadonlyArray<LiteratureWatchPick>;
    readonly summary?: string;
    readonly now: Date;
  },
): Promise<LiteratureWatch> {
  return finishLiteratureWatchRun(library, input.watchId, input.runId, (watch, run) =>
    publishLiteratureWatchRun(
      watch,
      run,
      { picks: input.picks, ...(input.summary ? { summary: input.summary } : {}) },
      input.now,
    ),
  );
}

/** What to add a briefing item to the Library by, as the identifier intake reads it. */
export function literatureWatchItemEntry(candidate: LiteratureWatchCandidate): string | null {
  const { ids } = candidate;
  if (ids.doi) return ids.doi;
  if (ids.pmid) return `pmid:${ids.pmid}`;
  if (ids.arxiv) return `arxiv:${ids.arxiv}`;
  if (ids.openalex) return `openalex:${ids.openalex}`;
  return null;
}
