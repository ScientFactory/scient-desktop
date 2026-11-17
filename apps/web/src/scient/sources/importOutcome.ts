import type {
  ScientSourceImportOperation,
  ScientSourcesFileImportResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";

import { countOf, referenceFileNotes } from "./referenceFileSummary";

type ScientSourceDuplicateKind = ScientSourcesPreflightResult["items"][number]["duplicate"]["kind"];

export type ScientSourcesImportCounts = {
  readonly imported: number;
  readonly alreadyPresent: number;
  readonly reviewRequired: number;
  readonly failed: number;
};

export type ScientSourcesImportOutcome = {
  readonly kind: "imported" | "already-present" | "review-required";
  readonly operation: ScientSourceImportOperation | null;
  readonly sourceId: string | null;
  readonly existingSourceId: string | null;
  readonly counts: ScientSourcesImportCounts;
};

const EMPTY_IMPORT_COUNTS: ScientSourcesImportCounts = {
  imported: 0,
  alreadyPresent: 0,
  reviewRequired: 0,
  failed: 0,
};

export function isExactSourceDuplicate(kind: ScientSourceDuplicateKind): boolean {
  return kind === "same-origin" || kind === "same-identifier" || kind === "same-pdf";
}

export function preflightImportCounts(
  preflight: ScientSourcesPreflightResult,
): ScientSourcesImportCounts {
  let alreadyPresent = 0;
  let reviewRequired = 0;
  for (const item of preflight.items) {
    if (isExactSourceDuplicate(item.duplicate.kind)) alreadyPresent += 1;
    if (item.duplicate.kind === "possible-metadata-match") reviewRequired += 1;
  }
  return { imported: 0, alreadyPresent, reviewRequired, failed: 0 };
}

export function reviewedImportCounts(
  preflight: ScientSourcesPreflightResult,
  selectedItemKeys: ReadonlySet<string>,
): ScientSourcesImportCounts {
  let alreadyPresent = 0;
  let reviewRequired = 0;
  for (const item of preflight.items) {
    const selected = selectedItemKeys.has(item.candidate.sourceKey);
    // A selected PDF of a paper already here goes into the import, which counts it.
    if (isExactSourceDuplicate(item.duplicate.kind) && !selected) alreadyPresent += 1;
    if (item.duplicate.kind === "possible-metadata-match" && !selected) reviewRequired += 1;
  }
  return { imported: 0, alreadyPresent, reviewRequired, failed: 0 };
}

export function completedImportCounts(
  operation: ScientSourceImportOperation,
  prior: ScientSourcesImportCounts = EMPTY_IMPORT_COUNTS,
): ScientSourcesImportCounts {
  let imported = prior.imported;
  let alreadyPresent = prior.alreadyPresent;
  let reviewRequired = prior.reviewRequired;
  let failed = prior.failed;
  for (const item of operation.items) {
    if (item.state === "imported") {
      imported += 1;
      continue;
    }
    if (item.state === "failed") {
      failed += 1;
      continue;
    }
    if (item.state !== "skipped") continue;
    if (item.duplicateKind && isExactSourceDuplicate(item.duplicateKind)) {
      alreadyPresent += 1;
      continue;
    }
    // Old persisted operations do not contain duplicateKind. Treating an
    // unclassified skip as review-required avoids falsely claiming identity.
    reviewRequired += 1;
  }
  return { imported, alreadyPresent, reviewRequired, failed };
}

export function importedSourceIdToReveal(outcome: ScientSourcesImportOutcome): string | null {
  return outcome.kind === "imported" ? outcome.sourceId : null;
}

export function importedSourceIds(outcome: ScientSourcesImportOutcome): ReadonlyArray<string> {
  if (outcome.kind !== "imported") return [];
  const sourceIds = new Set<string>();
  for (const item of outcome.operation?.items ?? []) {
    if (item.state === "imported" && item.sourceId) sourceIds.add(item.sourceId);
  }
  if (outcome.sourceId) sourceIds.add(outcome.sourceId);
  return [...sourceIds];
}

/**
 * Where an import puts what it brings: a project that keeps its sources in its own folder, a
 * project of My Library (the import adds each source to it), or My Library alone.
 */
export type ImportTarget = "project-folder" | "project" | "library";

export interface ImportReceiptInput {
  /** The finished import; null when nothing was staged (a file with nothing new, all present). */
  readonly operation: ScientSourceImportOperation | null;
  /** Its outcome; counts beyond the operation's are references left out before it began. */
  readonly outcome: ScientSourcesImportOutcome | null;
  readonly referenceFile: {
    readonly name: string;
    readonly report: ScientSourcesFileImportResult["report"];
  } | null;
  /** Where the import was going, for one with no operation to say. */
  readonly target: ImportTarget;
  /** What was imported, for one with no operation to say: PDFs are counted as PDFs. */
  readonly intake?: ScientSourceImportOperation["intake"] | undefined;
  /** A source's title, to name a work in place of its citation key. */
  readonly sourceTitle?: ((sourceId: string) => string | null) | undefined;
  /** Whether a source lacks details a PDF import looks for (authors, year, an identifier). */
  readonly detailsMissing?: ((sourceId: string) => boolean) | undefined;
  /** Whether another source here may be another version of it (a preprint, its paper). */
  readonly hasOtherVersion?: ((sourceId: string) => boolean) | undefined;
}

export interface ImportReceipt {
  readonly tone: "success" | "error" | "info";
  /** What the import did, success first. */
  readonly headline: string;
  /** The exceptions, in plain sentences, most important first. */
  readonly notes: ReadonlyArray<string>;
  /** Every entry the reference file's notes count, one line each. */
  readonly fileDetails: ReadonlyArray<string>;
  /** Why each reference that failed could not be imported. */
  readonly failures: ReadonlyArray<string>;
  readonly failed: number;
  /** Sources the import put in My Library only, which can be added to this project. */
  readonly libraryOnlySourceIds: ReadonlyArray<string>;
  /** The one source that was already present, to open. */
  readonly existingSourceId: string | null;
  /** Sources a PDF import made whose details were not all found, to check. */
  readonly detailsToCheckSourceIds: ReadonlyArray<string>;
}

const were = (count: number) => (count === 1 ? "was" : "were");

/** What a finished import did, counted from its items, with the reference file's exceptions. */
export function describeImport(input: ImportReceiptInput): ImportReceipt {
  const { operation, outcome, referenceFile } = input;
  const target: ImportTarget = !operation
    ? input.target
    : operation.formatVersion === 1
      ? "project-folder"
      : operation.pinInstanceId
        ? "project"
        : "library";
  const pdfs = (operation?.intake ?? input.intake) === "local-pdf";
  const noun = (count: number) =>
    countOf(count, pdfs ? "PDF" : "reference", pdfs ? "PDFs" : "references");
  const items = operation?.items ?? [];
  let fresh = 0;
  let fromLibrary = 0;
  let pinned = 0;
  let here = 0;
  let inLibrary = 0;
  let review = 0;
  let failed = 0;
  let unprocessed = 0;
  let attached = 0;
  const freshIds: string[] = [];
  const presentIds: string[] = [];
  const failures: string[] = [];
  for (const item of items) {
    if (item.state === "imported") {
      fresh += 1;
      if (item.sourceId) freshIds.push(item.sourceId);
    } else if (item.state === "failed") {
      failed += 1;
      failures.push(item.message ?? "It could not be imported.");
    } else if (item.state === "pending") {
      unprocessed += 1;
    } else if (!item.duplicateKind || !isExactSourceDuplicate(item.duplicateKind)) {
      review += 1;
    } else if (item.attachedPdf) {
      attached += 1;
      if (item.sourceId) presentIds.push(item.sourceId);
    } else {
      if (item.sourceId) presentIds.push(item.sourceId);
      const keys = item.citationKeys ?? [];
      if (target === "library") inLibrary += 1;
      else if (target === "project-folder") here += 1;
      // A key this project did not cite the work by, or a key of its own: added here now.
      else if (keys.some((key) => key.outcome === "added") || item.projectKey) fromLibrary += 1;
      else if (keys.length > 0) here += 1;
      else pinned += 1;
    }
  }
  // Left out before the import began; a reference file says its own in the notes.
  const counted = operation ? completedImportCounts(operation) : EMPTY_IMPORT_COUNTS;
  const priorPresent =
    outcome && !referenceFile
      ? Math.max(0, outcome.counts.alreadyPresent - counted.alreadyPresent)
      : 0;
  review += outcome ? Math.max(0, outcome.counts.reviewRequired - counted.reviewRequired) : 0;
  if (target === "project-folder") here += priorPresent;
  else inLibrary += priorPresent;

  const present = [
    { count: here, place: (count: number) => `${were(count)} already in this project` },
    {
      count: pinned,
      place: (count: number) =>
        count === 1
          ? "was already in My Library and is in this project now"
          : "were already in My Library and are in this project now",
    },
    { count: inLibrary, place: (count: number) => `${were(count)} already in My Library` },
  ].filter((entry) => entry.count > 0);

  const notes: string[] = [];
  let headline: string;
  const added = fresh + fromLibrary;
  const attachedTo = (count: number) =>
    `added to ${count === 1 ? "its source" : "their sources"}, already in ${target === "project-folder" ? "this project" : "My Library"}`;
  if (referenceFile && referenceFile.report.entryCount === 0) {
    headline = `No references found in ${referenceFile.name}`;
  } else if (added > 0) {
    headline =
      target === "library"
        ? `${noun(fresh)} imported and added to My Library`
        : fromLibrary === 0
          ? `${noun(fresh)} imported and added to this project`
          : fresh === 0
            ? `${noun(fromLibrary)} added to this project from My Library`
            : `${noun(added)} added to this project: ${fresh.toLocaleString()} imported, ${fromLibrary.toLocaleString()} already in My Library`;
  } else if (attached > 0) {
    headline = `${noun(attached)} ${attachedTo(attached)}`;
  } else if (present.length > 0) {
    const [first] = present.splice(0, 1);
    headline = `${noun(first!.count)} ${first!.place(first!.count)}`;
  } else if (operation?.state === "cancelled") {
    headline = "The import was stopped before anything was imported";
  } else {
    headline = referenceFile
      ? `Nothing was imported from ${referenceFile.name}`
      : "Nothing was imported";
  }
  if (added > 0 && attached > 0) {
    notes.push(`${attached.toLocaleString()} ${were(attached)} ${attachedTo(attached)}`);
  }
  notes.push(
    ...present.map((entry) => `${entry.count.toLocaleString()} ${entry.place(entry.count)}`),
  );
  // What a PDF import could not find is said here, not left for the person to come across.
  const toCheck = pdfs && input.detailsMissing ? freshIds.filter(input.detailsMissing) : [];
  if (toCheck.length > 0) {
    notes.push(
      `${toCheck.length.toLocaleString()} ${toCheck.length === 1 ? "has" : "have"} details Scient could not find: check ${toCheck.length === 1 ? "it" : "them"}`,
    );
  }
  // Kept as its own source; Possible duplicates offers the merge.
  const versions = input.hasOtherVersion ? freshIds.filter(input.hasOtherVersion).length : 0;
  if (versions > 0) {
    notes.push(
      `${versions.toLocaleString()} may be another version of a source already here (a preprint and its published paper): see Possible duplicates`,
    );
  }
  const file =
    referenceFile && referenceFile.report.entryCount > 0
      ? referenceFileNotes({
          report: referenceFile.report,
          items,
          sourceTitle: input.sourceTitle,
        })
      : { notes: [], details: [] };
  notes.push(...file.notes);
  if (review > 0) {
    notes.push(
      `${review.toLocaleString()} may already be in ${target === "project-folder" ? "this project" : "My Library"} and ${were(review)} not imported`,
    );
  }
  if (failed > 0) notes.push(`${failed.toLocaleString()} could not be imported`);
  if (unprocessed > 0) {
    notes.push(
      `The import was stopped; ${unprocessed.toLocaleString()} ${were(unprocessed)} not imported`,
    );
  }
  return {
    tone: failed > 0 ? "error" : added > 0 ? "success" : "info",
    headline,
    notes,
    fileDetails: file.details,
    failures,
    failed,
    libraryOnlySourceIds: target === "library" ? freshIds : [],
    existingSourceId:
      added === 0 && presentIds.length === 1
        ? presentIds[0]!
        : added === 0 && !operation
          ? (outcome?.existingSourceId ?? null)
          : null,
    detailsToCheckSourceIds: toCheck,
  };
}
