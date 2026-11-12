import {
  SCIENT_SOURCES_BULK_SOURCE_LIMIT,
  type ScientSourcesBulkChange,
} from "@scientfactory/scient-sources";
import type { ScientSourcesBulkResult } from "@t3tools/contracts";

/**
 * Sources per bulk edit request once a selection is larger than one request takes. A part of
 * 100 took at most 2.4 s at 20,000 records on a quiet Mac, and its Undo 1.3 s, so it stays under
 * a third of the 15 s request timeout at twice that on a loaded one (docs/internals).
 */
const SOURCES_PER_BULK_PART = Math.min(100, SCIENT_SOURCES_BULK_SOURCE_LIMIT);

/** How a run of parts ended: all sent, stopped by the person, refused, or with no answer. */
export type PartsEnd =
  | { readonly kind: "done" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "lost"; readonly error: unknown; readonly unknown: number };

export interface PartsOutcome<A> {
  readonly total: number;
  /** Items in parts that were answered. */
  readonly answered: number;
  readonly results: ReadonlyArray<A>;
  readonly end: PartsEnd;
}

/** Items neither answered nor lost: known not to have been sent. */
export function partsNotSent(outcome: PartsOutcome<unknown>): number {
  return outcome.total - outcome.answered - (outcome.end.kind === "lost" ? outcome.end.unknown : 0);
}

export function splitIntoParts<A>(items: ReadonlyArray<A>, size: number): A[][] {
  const parts: A[][] = [];
  for (let start = 0; start < items.length; start += size) {
    parts.push(items.slice(start, start + size));
  }
  return parts;
}

/**
 * Sends the parts one after another and stops at the first that fails or gets no answer.
 * A stop asked for while a part is in flight takes effect once that part is answered.
 */
export async function runParts<I, A>(input: {
  readonly parts: ReadonlyArray<ReadonlyArray<I>>;
  readonly send: (items: ReadonlyArray<I>, index: number) => Promise<A>;
  readonly isLost: (error: unknown) => boolean;
  readonly onProgress?: (answered: number) => void;
  readonly stopRequested?: () => boolean;
  /** Items answered before the first part, such as a request made ahead of the run. */
  readonly answeredBefore?: number;
  readonly totalBefore?: number;
}): Promise<PartsOutcome<A>> {
  const total = (input.totalBefore ?? 0) + input.parts.reduce((sum, part) => sum + part.length, 0);
  let answered = input.answeredBefore ?? 0;
  const results: A[] = [];
  for (const [index, part] of input.parts.entries()) {
    if (input.stopRequested?.()) return { total, answered, results, end: { kind: "stopped" } };
    let result: A;
    try {
      result = await input.send(part, index);
    } catch (error) {
      const end: PartsEnd = input.isLost(error)
        ? { kind: "lost", error, unknown: part.length }
        : { kind: "failed", error };
      return { total, answered, results, end };
    }
    results.push(result);
    answered += part.length;
    input.onProgress?.(answered);
  }
  return { total, answered, results, end: { kind: "done" } };
}

/** One bulk edit as requests: the selection split into parts, the rest of the change on each. */
export function bulkChangeParts(
  change: ScientSourcesBulkChange,
  size = SOURCES_PER_BULK_PART,
): ScientSourcesBulkChange[] {
  return splitIntoParts([...new Set(change.sourceIds)], size).map((sourceIds) => ({
    ...change,
    sourceIds,
  }));
}

export interface BulkUndoPart {
  readonly batchId: string;
  readonly sourceCount: number;
  /** Its Undo was sent before and got no answer, so it may already be undone. */
  readonly resent?: true;
}

/** The parts' answers as one: per-source and per-collection outcomes, and each part's Undo. */
export function sumBulkResults(results: ReadonlyArray<ScientSourcesBulkResult>): {
  readonly result: ScientSourcesBulkResult;
  readonly undo: ReadonlyArray<BulkUndoPart>;
  readonly changed: number;
} {
  const undo = results.flatMap((result) => (result.undo ? [result.undo] : []));
  const conflicts = results.flatMap((result) => result.conflicts ?? []);
  return {
    result: {
      sources: results.flatMap((result) => result.sources),
      collections: results.flatMap((result) => result.collections),
      ...(conflicts.length > 0 ? { conflicts } : {}),
    },
    undo,
    changed: undo.reduce((sum, part) => sum + part.sourceCount, 0),
  };
}

export interface BulkUndoOutcome {
  /** The answered Undo requests as one; null when none was answered. */
  readonly result: ScientSourcesBulkResult | null;
  /** Parts to undo again, in edit order: those with a failed entry and those not answered. */
  readonly retry: ReadonlyArray<BulkUndoPart>;
  /** Changes in parts whose Undo was not answered or not sent. */
  readonly unanswered: number;
  /** Changes in parts whose Undo record is gone or was used elsewhere, with the server's words. */
  readonly unavailable: number;
  readonly unavailableMessage?: string;
  readonly end: { readonly kind: "done" | "failed" | "lost"; readonly error?: unknown };
}

/** The server's words when a part's Undo record is gone or already used: it undid nothing. */
const nothingToUndo = (result: ScientSourcesBulkResult) =>
  result.sources.length === 0 && result.collections.length === 0
    ? result.conflicts?.[0]?.message
    : undefined;

/** Undoes the parts newest first and stops at the first request that fails or gets no answer. */
export async function undoBulkParts(input: {
  readonly parts: ReadonlyArray<BulkUndoPart>;
  readonly send: (batchId: string) => Promise<ScientSourcesBulkResult>;
  readonly isLost: (error: unknown) => boolean;
  readonly onPartDone?: (part: BulkUndoPart) => void;
}): Promise<BulkUndoOutcome> {
  const newestFirst = input.parts.toReversed();
  const answered: ScientSourcesBulkResult[] = [];
  const retry: BulkUndoPart[] = [];
  let unavailable = 0;
  let unavailableMessage: string | undefined;
  const sums = () => ({
    result: answered.length > 0 ? sumBulkResults(answered).result : null,
    unavailable,
    ...(unavailableMessage === undefined ? {} : { unavailableMessage }),
  });
  for (const [index, part] of newestFirst.entries()) {
    let result: ScientSourcesBulkResult;
    try {
      result = await input.send(part.batchId);
    } catch (error) {
      const lost = input.isLost(error);
      const unsent = newestFirst.slice(index + 1);
      const left = [lost ? { ...part, resent: true as const } : part, ...unsent];
      return {
        ...sums(),
        retry: [...retry, ...left].toReversed(),
        unanswered: left.reduce((total, entry) => total + entry.sourceCount, 0),
        end: { kind: lost ? "lost" : "failed", error },
      };
    }
    const nothing = nothingToUndo(result);
    if (nothing === undefined) {
      answered.push(result);
      if (failedEntries(result) > 0) {
        retry.push({ batchId: part.batchId, sourceCount: part.sourceCount });
      }
    } else if (!part.resent) {
      // A part sent again after a lost answer was undone by the first request.
      unavailable += part.sourceCount;
      unavailableMessage ??= nothing;
    }
    input.onPartDone?.(part);
  }
  return { ...sums(), retry: retry.toReversed(), unanswered: 0, end: { kind: "done" } };
}

function failedEntries(result: ScientSourcesBulkResult): number {
  return [...result.sources, ...result.collections].filter((entry) => entry.outcome === "failed")
    .length;
}

export interface PartsAnnouncement {
  readonly type: "success" | "info" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

const count = (value: number) => value.toLocaleString();
const sources = (value: number) => `${count(value)} ${value === 1 ? "source" : "sources"}`;
const others = (value: number, verb: string) =>
  value === 1
    ? `1 other source was not ${verb}.`
    : `${count(value)} other sources were not ${verb}.`;
const noAnswer = (value: number, noun: string, verb: string) =>
  `No answer came back for ${count(value)} ${value === 1 ? noun : `${noun}s`}, so whether ${
    value === 1 ? "it was" : "they were"
  } ${verb} is unknown.`;
const sentences = (...parts: ReadonlyArray<string | null>) =>
  parts.filter((part): part is string => Boolean(part)).join(" ");

/** What happened past the parts that were answered; null when every part was. */
function partsDetail(
  outcome: PartsOutcome<unknown>,
  verb: string,
  message: (error: unknown) => string,
): string | null {
  const { end } = outcome;
  const notSent = partsNotSent(outcome);
  switch (end.kind) {
    case "done":
      return null;
    case "stopped":
      return sentences("Stopped.", others(notSent, verb));
    case "failed":
      return sentences(outcome.answered > 0 ? others(notSent, verb) : null, message(end.error));
    case "lost":
      return sentences(
        noAnswer(end.unknown, "source", verb),
        notSent > 0 ? others(notSent, verb) : null,
      );
  }
}

/** The one toast that ends a bulk edit sent in parts; Undo goes with it when something changed. */
export function bulkPartsAnnouncement(input: {
  readonly outcome: PartsOutcome<unknown>;
  readonly changed: number;
  readonly failureTitle: string;
  readonly message: (error: unknown) => string;
  /** What went wrong for single sources in the answered parts, in the one-request words. */
  readonly problem?: string | null;
}): PartsAnnouncement | null {
  const { end } = input.outcome;
  const problem = input.problem ?? null;
  const detail = sentences(problem, partsDetail(input.outcome, "changed", input.message));
  const description = detail ? { description: detail } : {};
  const clean = problem === null && (end.kind === "done" || end.kind === "stopped");
  if (input.changed > 0) {
    return {
      type: clean ? "success" : "warning",
      title: `Changed ${sources(input.changed)}`,
      ...description,
    };
  }
  if (clean && end.kind === "done") return null;
  return {
    type: end.kind === "failed" ? "error" : clean ? "info" : "warning",
    title: input.failureTitle,
    ...description,
  };
}

/** Said only when filling a new collection in parts did not finish. */
export function collectionPartsAnnouncement(input: {
  readonly outcome: PartsOutcome<unknown>;
  readonly name: string;
  readonly message: (error: unknown) => string;
}): PartsAnnouncement | null {
  const detail = partsDetail(input.outcome, "added", input.message);
  if (!detail) return null;
  return {
    type: input.outcome.end.kind === "stopped" ? "info" : "warning",
    title: `Not every source was added to “${input.name}”`,
    description: detail,
  };
}

/** The words of a one-request Undo, with the counts summed over the parts. */
export function undoPartsAnnouncement(
  outcome: BulkUndoOutcome,
  message: (error: unknown) => string,
): PartsAnnouncement | null {
  const { result, end, unavailable } = outcome;
  const failed = result ? failedEntries(result) : 0;
  const couldNot = (value: number) =>
    value === 1 ? "1 change could not be undone." : `${count(value)} changes could not be undone.`;
  const why = outcome.unavailableMessage ?? null;
  if (end.kind === "lost") {
    return {
      type: "warning",
      title: "Undo did not finish",
      description: sentences(
        failed + unavailable > 0 ? couldNot(failed + unavailable) : null,
        why,
        noAnswer(outcome.unanswered, "change", "undone"),
      ),
    };
  }
  if (end.kind === "failed" && result === null && unavailable === 0) {
    return { type: "error", title: "Changes were not undone", description: message(end.error) };
  }
  const notUndone = failed + outcome.unanswered + unavailable;
  if (notUndone > 0) {
    const nothingUndone = result === null && outcome.unanswered === 0;
    return {
      type: "warning",
      title: nothingUndone ? "Changes were not undone" : "Some changes were not undone",
      description: sentences(
        nothingUndone ? null : couldNot(notUndone),
        why,
        end.kind === "failed" ? message(end.error) : null,
      ),
    };
  }
  const conflicts = result?.conflicts ?? [];
  if (!result || conflicts.length === 0) return null;
  const undidNothing = result.sources.length === 0 && result.collections.length === 0;
  return {
    type: "warning",
    title: undidNothing ? "Changes were not undone" : "Some later changes were kept",
    description:
      conflicts.length === 1
        ? conflicts[0]!.message
        : `${conflicts[0]!.message} ${conflicts.length - 1} more were kept as well.`,
  };
}
