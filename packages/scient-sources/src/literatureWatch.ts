// @effect-diagnostics globalDate:off -- Watch files carry interoperable ISO days and timestamps.
import * as Schema from "effect/Schema";

import { ScientSourceActor } from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";

const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Day = NonEmptyString.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u));
const Line = NonEmptyString.check(Schema.isMaxLength(600));
const Query = NonEmptyString.check(Schema.isMaxLength(4_000));

export const LiteratureWatchService = Schema.Literals(["pubmed", "openalex", "arxiv"]);
export type LiteratureWatchService = typeof LiteratureWatchService.Type;
export const LITERATURE_WATCH_SERVICES: ReadonlyArray<LiteratureWatchService> = [
  "pubmed",
  "openalex",
  "arxiv",
];

/** One query per service, written in that service's own syntax. */
export const LiteratureWatchQueries = Schema.Struct({
  pubmed: Schema.optionalKey(Query),
  openalex: Schema.optionalKey(Query),
  arxiv: Schema.optionalKey(Query),
});
export type LiteratureWatchQueries = typeof LiteratureWatchQueries.Type;

export const LiteratureWatchIds = Schema.Struct({
  doi: Schema.optionalKey(NonEmptyString),
  pmid: Schema.optionalKey(NonEmptyString),
  pmcid: Schema.optionalKey(NonEmptyString),
  arxiv: Schema.optionalKey(NonEmptyString),
  openalex: Schema.optionalKey(NonEmptyString),
});
export type LiteratureWatchIds = typeof LiteratureWatchIds.Type;

export const LiteratureWatchCandidate = Schema.Struct({
  candidateId: NonEmptyString,
  title: NonEmptyString.check(Schema.isMaxLength(2_000)),
  abstract: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
  authors: Schema.Array(NonEmptyString).check(Schema.isMaxLength(12)),
  authorCount: Count,
  venue: Schema.optionalKey(NonEmptyString),
  published: Schema.optionalKey(Day),
  ids: LiteratureWatchIds,
  services: Schema.Array(LiteratureWatchService).check(Schema.isMinLength(1)),
  kinds: Schema.optionalKey(Schema.Array(NonEmptyString).check(Schema.isMaxLength(12))),
});
export type LiteratureWatchCandidate = typeof LiteratureWatchCandidate.Type;
export type LiteratureWatchFound = Omit<LiteratureWatchCandidate, "candidateId">;

/**
 * `partial`: the service held more than one run reads. `coveredTo` is then the last day read in
 * full, which the watch moves to, so the next run goes on from there.
 */
export const LiteratureWatchServiceRun = Schema.Struct({
  service: LiteratureWatchService,
  from: Day,
  to: Day,
  status: Schema.Literals(["complete", "partial", "failed"]),
  found: Count,
  total: Schema.optionalKey(Count),
  coveredTo: Schema.optionalKey(Day),
  error: Schema.optionalKey(Line),
});
export type LiteratureWatchServiceRun = typeof LiteratureWatchServiceRun.Type;

/** A run between fetching and publishing; kept in its own file and removed on publish. */
export const LiteratureWatchRun = Schema.Struct({
  formatVersion: Schema.Literal(1),
  watchId: NonEmptyString,
  runId: NonEmptyString,
  startedAt: NonEmptyString,
  services: Schema.Array(LiteratureWatchServiceRun),
  alreadySeen: Count,
  candidates: Schema.Array(LiteratureWatchCandidate),
  /** How many candidates, in order, the agent has been given; only those count as screened. */
  delivered: Count,
  /** The watch's `revision` the run searched with; a run from before an edit cannot publish. */
  revision: Schema.optionalKey(Count),
});
export type LiteratureWatchRun = typeof LiteratureWatchRun.Type;

const LITERATURE_WATCH_MAX_ITEMS = 40;

export const LiteratureWatchEvidence = Schema.Literals(["title", "abstract", "full-text"]);
export type LiteratureWatchEvidence = typeof LiteratureWatchEvidence.Type;

export const LiteratureWatchTriage = Schema.Struct({
  action: Schema.Literals(["kept", "dismissed"]),
  at: NonEmptyString,
  by: ScientSourceActor,
  sourceId: Schema.optionalKey(NonEmptyString),
});
export type LiteratureWatchTriage = typeof LiteratureWatchTriage.Type;

export const LiteratureWatchItem = Schema.Struct({
  candidate: LiteratureWatchCandidate,
  why: Line,
  details: Schema.Array(Line).check(Schema.isMaxLength(12)),
  evidence: LiteratureWatchEvidence,
  triage: Schema.optionalKey(LiteratureWatchTriage),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type LiteratureWatchItem = typeof LiteratureWatchItem.Type;

/** What one run showed, frozen on publish; only triage and notes change afterwards. */
export const LiteratureWatchBriefing = Schema.Struct({
  briefingId: NonEmptyString,
  publishedAt: NonEmptyString,
  services: Schema.Array(LiteratureWatchServiceRun),
  screened: Count,
  /** Candidates the agent never saw; their services keep their old days. */
  unscreened: Schema.optionalKey(Count),
  summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  items: Schema.Array(LiteratureWatchItem).check(Schema.isMaxLength(LITERATURE_WATCH_MAX_ITEMS)),
  openedAt: Schema.optionalKey(NonEmptyString),
});
export type LiteratureWatchBriefing = typeof LiteratureWatchBriefing.Type;

/** The first this many items are the briefing; the rest show as more matches. */
export const LITERATURE_WATCH_FEATURED_ITEMS = 8;

/** A work a run already judged, by every identity key it had, so no later run shows it again. */
export const LiteratureWatchSeen = Schema.Struct({
  keys: Schema.Array(NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  fate: Schema.Literals(["shown", "passed"]),
  runId: NonEmptyString,
});
export type LiteratureWatchSeen = typeof LiteratureWatchSeen.Type;

export const LiteratureWatchDefinition = Schema.Struct({
  title: NonEmptyString.check(Schema.isMaxLength(200)),
  /** The researcher's words: what to watch for and what to leave out. */
  request: NonEmptyString.check(Schema.isMaxLength(4_000)),
  /** What to say about each paper, such as methods or sample size. */
  details: Schema.optionalKey(NonEmptyString.check(Schema.isMaxLength(2_000))),
  queries: LiteratureWatchQueries,
  everyDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
});
export type LiteratureWatchDefinition = typeof LiteratureWatchDefinition.Type;

export const LiteratureWatch = Schema.Struct({
  formatVersion: Schema.Literal(1),
  watchId: NonEmptyString,
  ...LiteratureWatchDefinition.fields,
  paused: Schema.optionalKey(Schema.Literal(true)),
  /** Raised whenever what the watch searches for changes. */
  revision: Schema.optionalKey(Count),
  /** The thread settings its scheduled runs use, in the server's own contract shape. */
  runner: Schema.optionalKey(Schema.Unknown),
  /** Per service, the last day a run searched completely; the next run starts there. */
  covered: Schema.Struct({
    pubmed: Schema.optionalKey(Day),
    openalex: Schema.optionalKey(Day),
    arxiv: Schema.optionalKey(Day),
  }),
  /** Per service, where a run that ran out of room left off; the next starts there, no overlap. */
  resumeAt: Schema.optionalKey(
    Schema.Struct({
      pubmed: Schema.optionalKey(Day),
      openalex: Schema.optionalKey(Day),
      arxiv: Schema.optionalKey(Day),
    }),
  ),
  seen: Schema.Array(LiteratureWatchSeen),
  briefings: Schema.Array(LiteratureWatchBriefing),
  createdAt: NonEmptyString,
  createdBy: ScientSourceActor,
  updatedAt: NonEmptyString,
});
export type LiteratureWatch = typeof LiteratureWatch.Type;

/** A first run looks back this far, so the first briefing doubles as a preview. */
const LITERATURE_WATCH_FIRST_DAYS = 30;
/**
 * OpenAlex filters only by publication date without a paid plan, and papers reach it weeks after
 * that date; every run reads this many days back and the seen ledger drops what was judged.
 */
const LITERATURE_WATCH_OPENALEX_DAYS = 30;
/** PubMed and arXiv records land a little late in their own date fields. */
const OVERLAP_DAYS = 2;
const KEPT_BRIEFINGS = 52;
/** About a year of a busy watch; older entries are past every service's rescan. */
const KEPT_SEEN = 60_000;

function literatureWatchDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function daysBefore(day: string, days: number): string {
  return literatureWatchDay(new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000));
}

/** The days a run searches one service, inclusive. */
export function literatureWatchWindow(
  watch: Pick<LiteratureWatch, "covered" | "createdAt" | "resumeAt">,
  service: LiteratureWatchService,
  now: Date,
): { readonly from: string; readonly to: string } {
  const to = literatureWatchDay(now);
  // Until a service answers once, every run reaches back to the month before the watch began.
  const first = daysBefore(
    [to, watch.createdAt.slice(0, 10)].toSorted()[0]!,
    LITERATURE_WATCH_FIRST_DAYS,
  );
  // OpenAlex dates are publication dates, which late indexing fills in behind, so it always rescans.
  const resumeAt = service === "openalex" ? undefined : watch.resumeAt?.[service];
  if (resumeAt) return { from: resumeAt > to ? to : resumeAt, to };
  const covered = watch.covered[service];
  const resume = covered ? daysBefore(covered, OVERLAP_DAYS) : first;
  // After a long closure the gap reaches past the usual rescan, so it starts at the gap instead.
  const from =
    service === "openalex"
      ? [resume, daysBefore(to, LITERATURE_WATCH_OPENALEX_DAYS)].toSorted()[0]!
      : resume;
  return { from: from > to ? to : from, to };
}

function titleKey(title: string): string | null {
  const words = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return words.length >= 20 ? `title:${words.slice(0, 160).trim()}` : null;
}

/** Every key a work is known by: its identifiers, then its normalized title. */
function literatureWatchKeys(found: Pick<LiteratureWatchFound, "ids" | "title">) {
  const keys: string[] = [];
  const { ids } = found;
  if (ids.doi) keys.push(`doi:${normalizePersistentIdentifier("doi", ids.doi)}`);
  if (ids.pmid) keys.push(`pmid:${ids.pmid.trim()}`);
  if (ids.arxiv) keys.push(`arxiv:${ids.arxiv.trim().toLowerCase().replace(/v\d+$/u, "")}`);
  if (ids.openalex) keys.push(`openalex:${ids.openalex.trim().toUpperCase()}`);
  const title = titleKey(found.title);
  if (title) keys.push(title);
  return keys;
}

const isTitleKey = (key: string) => key.startsWith("title:");

function sameDoi(left: string, right: string) {
  return normalizePersistentIdentifier("doi", left) === normalizePersistentIdentifier("doi", right);
}

function mergeFound(into: LiteratureWatchFound, other: LiteratureWatchFound): LiteratureWatchFound {
  const longer = (other.abstract?.length ?? 0) > (into.abstract?.length ?? 0);
  return {
    ...other,
    ...into,
    ids: { ...other.ids, ...into.ids },
    services: [...new Set([...into.services, ...other.services])],
    ...(longer && other.abstract ? { abstract: other.abstract } : {}),
  };
}

/**
 * The run's candidates: the services' records merged by any shared key, without the works an
 * earlier run judged. Order follows the services' answers.
 */
export function literatureWatchCandidates(
  found: ReadonlyArray<LiteratureWatchFound>,
  seen: ReadonlyArray<LiteratureWatchSeen>,
): { readonly candidates: ReadonlyArray<LiteratureWatchCandidate>; readonly alreadySeen: number } {
  const judged = new Set(seen.flatMap((entry) => entry.keys.filter((key) => !isTitleKey(key))));
  // A title alone marks a work judged only when no DOI on either side says it is another one.
  const judgedDois = new Map<string, ReadonlyArray<string>>();
  for (const entry of seen) {
    const title = entry.keys.find(isTitleKey);
    if (!title) continue;
    const dois = entry.keys.filter((key) => key.startsWith("doi:"));
    judgedDois.set(title, [...(judgedDois.get(title) ?? []), ...(dois.length ? dois : ["any"])]);
  }
  const wasJudged = (record: LiteratureWatchFound) =>
    literatureWatchKeys(record).some((key) => {
      if (!isTitleKey(key)) return judged.has(key);
      const dois = judgedDois.get(key);
      const doi = record.ids.doi && `doi:${normalizePersistentIdentifier("doi", record.ids.doi)}`;
      return dois !== undefined && (!doi || dois.includes("any") || dois.includes(doi));
    });
  const merged: LiteratureWatchFound[] = [];
  const byKey = new Map<string, number>();
  for (const record of found) {
    const keys = literatureWatchKeys(record);
    const index = keys
      .map((key) => byKey.get(key))
      .find(
        (at) =>
          at !== undefined &&
          // Same title, different DOIs: two papers, such as an erratum and its article.
          !(record.ids.doi && merged[at]!.ids.doi && !sameDoi(record.ids.doi, merged[at]!.ids.doi)),
      );
    if (index === undefined) {
      merged.push(record);
      for (const key of keys) byKey.set(key, merged.length - 1);
    } else {
      merged[index] = mergeFound(merged[index]!, record);
      for (const key of literatureWatchKeys(merged[index]!)) byKey.set(key, index);
    }
  }
  const fresh = merged.filter((record) => !wasJudged(record));
  return {
    candidates: fresh.map((record, index) => ({ ...record, candidateId: `c${index + 1}` })),
    alreadySeen: merged.length - fresh.length,
  };
}

export interface LiteratureWatchPick {
  readonly candidateId: string;
  readonly why: string;
  readonly details: ReadonlyArray<string>;
  readonly evidence: LiteratureWatchEvidence;
}

// @effect-diagnostics-next-line extendsNativeError:off - The source stores are Promise-based; callers catch native errors.
export class LiteratureWatchPublishError extends Error {}

/**
 * Freezes a run into a briefing: the picks in order, every candidate recorded as judged, and each
 * service that answered moved on to the run's last day. A failed service keeps its old day, so the
 * next run searches its gap again.
 */
export function publishLiteratureWatchRun(
  watch: LiteratureWatch,
  run: LiteratureWatchRun,
  input: { readonly picks: ReadonlyArray<LiteratureWatchPick>; readonly summary?: string },
  now: Date,
): LiteratureWatch {
  if (run.watchId !== watch.watchId) {
    throw new LiteratureWatchPublishError("This run belongs to another watch.");
  }
  if ((run.revision ?? 0) !== (watch.revision ?? 0)) {
    throw new LiteratureWatchPublishError(
      "The watch changed since this run began; start a new run.",
    );
  }
  if (input.picks.length > LITERATURE_WATCH_MAX_ITEMS) {
    throw new LiteratureWatchPublishError(
      `A briefing holds at most ${LITERATURE_WATCH_MAX_ITEMS} papers.`,
    );
  }
  const byId = new Map(run.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const picked = new Set<string>();
  const items = input.picks.map((pick): LiteratureWatchItem => {
    const candidate = byId.get(pick.candidateId);
    if (!candidate || run.candidates.indexOf(candidate) >= run.delivered) {
      throw new LiteratureWatchPublishError(`${pick.candidateId} is not a candidate of this run.`);
    }
    if (picked.has(pick.candidateId)) {
      throw new LiteratureWatchPublishError(`${pick.candidateId} is picked twice.`);
    }
    picked.add(pick.candidateId);
    // Briefings never show abstracts; keeping them would outgrow the watch file within a year.
    const { abstract: _abstract, ...shown } = candidate;
    return { candidate: shown, why: pick.why, details: pick.details, evidence: pick.evidence };
  });
  const screened = run.candidates.slice(0, run.delivered);
  const unscreened = run.candidates.length - screened.length;
  const covered = { ...watch.covered };
  const resumeAt = { ...watch.resumeAt };
  if (unscreened === 0) {
    for (const { service, status, from, to, coveredTo } of run.services) {
      // A partial service that reached its last day only skipped days too full to read.
      if (status === "complete" || coveredTo === to) {
        covered[service] = to;
        delete resumeAt[service];
      } else if (status === "partial") {
        // A run that ran out of room within days already covered must still move on.
        const reached = [covered[service], coveredTo].filter(Boolean).toSorted().at(-1);
        if (reached) covered[service] = reached;
        resumeAt[service] = reached ? daysBefore(reached, -1) : from;
      }
    }
  }
  const summary = input.summary?.trim();
  const briefing: LiteratureWatchBriefing = {
    briefingId: run.runId,
    publishedAt: now.toISOString(),
    services: run.services,
    screened: screened.length,
    ...(unscreened > 0 ? { unscreened } : {}),
    ...(summary ? { summary } : {}),
    items,
  };
  const { resumeAt: _resumeAt, ...rest } = watch;
  return {
    ...rest,
    covered,
    ...(Object.keys(resumeAt).length > 0 ? { resumeAt } : {}),
    seen: [
      ...watch.seen,
      ...screened.map((candidate): LiteratureWatchSeen => ({
        keys: literatureWatchKeys(candidate).slice(0, 6),
        fate: picked.has(candidate.candidateId) ? "shown" : "passed",
        runId: run.runId,
      })),
    ].slice(-KEPT_SEEN),
    briefings: [briefing, ...watch.briefings].slice(0, KEPT_BRIEFINGS),
    updatedAt: now.toISOString(),
  };
}

/**
 * After the topic changes, the last month is read again and papers earlier runs passed over are
 * judged anew; papers already shown, and what the person did with them, stay.
 */
export function retuneLiteratureWatch(watch: LiteratureWatch, now: Date): LiteratureWatch {
  const today = literatureWatchDay(now);
  const back = daysBefore(today, LITERATURE_WATCH_FIRST_DAYS - OVERLAP_DAYS);
  const covered = { ...watch.covered };
  for (const service of LITERATURE_WATCH_SERVICES) {
    const day = covered[service];
    if (day && day > back) covered[service] = back;
  }
  const { resumeAt: _resumeAt, ...rest } = watch;
  return { ...rest, covered, seen: watch.seen.filter((entry) => entry.fate === "shown") };
}

/** Sets or clears what the person did with one item; the briefing itself does not change. */
export function triageLiteratureWatchItem(
  watch: LiteratureWatch,
  target: { readonly briefingId: string; readonly candidateId: string },
  change: { readonly triage?: LiteratureWatchTriage | null; readonly note?: string | null },
  now: Date,
): LiteratureWatch {
  let found = false;
  const briefings = watch.briefings.map((briefing) => {
    if (briefing.briefingId !== target.briefingId) return briefing;
    return {
      ...briefing,
      items: briefing.items.map((item) => {
        if (item.candidate.candidateId !== target.candidateId) return item;
        found = true;
        const { triage: _triage, note: _note, ...rest } = item;
        const triage = change.triage === undefined ? item.triage : change.triage;
        const note = change.note === undefined ? item.note : change.note?.trim();
        return { ...rest, ...(triage ? { triage } : {}), ...(note ? { note } : {}) };
      }),
    };
  });
  if (!found) throw new LiteratureWatchPublishError("That paper is not in this briefing.");
  return { ...watch, briefings, updatedAt: now.toISOString() };
}

/** What the person kept and dismissed lately, newest first, for the next run to learn from. */
export function literatureWatchRecentTriage(watch: LiteratureWatch, limit = 40) {
  return watch.briefings
    .flatMap((briefing) => briefing.items)
    .filter((item) => item.triage || item.note)
    .toSorted((left, right) => (right.triage?.at ?? "").localeCompare(left.triage?.at ?? ""))
    .slice(0, limit)
    .map((item) => ({
      title: item.candidate.title,
      ...(item.triage ? { action: item.triage.action } : {}),
      ...(item.note ? { note: item.note } : {}),
    }));
}
