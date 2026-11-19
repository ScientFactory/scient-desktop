import type {
  ScientSourceImportOperation,
  ScientSourcesFileImportResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { referenceFileNotes } from "./referenceFileSummary";

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

/** A count for a plural message: `count` picks the form, `shown` is what it prints. */
const amount = (count: number) => ({ count, shown: count.toLocaleString() });

type Noun = "pdf" | "reference";
type Place = "project" | "library";

const IMPORT_LABELS = {
  itemFailed: msg("It could not be imported."),
  noReferences: msg("No references found in {name}"),
  stoppedBeforeAnything: msg("The import was stopped before anything was imported"),
  nothingFrom: msg("Nothing was imported from {name}"),
  nothing: msg("Nothing was imported"),
  toCheck: msg(
    "{count, plural, one {{shown} has details Scient could not find: check it} other {{shown} have details Scient could not find: check them}}",
  ),
  versions: msg(
    "{count, plural, one {{shown} may be another version of a source already here (a preprint and its published paper): see Possible duplicates} other {{shown} may be another version of a source already here (a preprint and its published paper): see Possible duplicates}}",
  ),
  failed: msg(
    "{count, plural, one {{shown} could not be imported} other {{shown} could not be imported}}",
  ),
  unprocessed: msg(
    "{count, plural, one {The import was stopped; {shown} was not imported} other {The import was stopped; {shown} were not imported}}",
  ),
} as const;

const ADDED_HEADLINES = {
  library: {
    pdf: msg(
      "{count, plural, one {{shown} PDF imported and added to My Library} other {{shown} PDFs imported and added to My Library}}",
    ),
    reference: msg(
      "{count, plural, one {{shown} reference imported and added to My Library} other {{shown} references imported and added to My Library}}",
    ),
  },
  project: {
    pdf: msg(
      "{count, plural, one {{shown} PDF imported and added to this project} other {{shown} PDFs imported and added to this project}}",
    ),
    reference: msg(
      "{count, plural, one {{shown} reference imported and added to this project} other {{shown} references imported and added to this project}}",
    ),
  },
  fromLibrary: {
    pdf: msg(
      "{count, plural, one {{shown} PDF added to this project from My Library} other {{shown} PDFs added to this project from My Library}}",
    ),
    reference: msg(
      "{count, plural, one {{shown} reference added to this project from My Library} other {{shown} references added to this project from My Library}}",
    ),
  },
  mixed: {
    pdf: msg(
      "{count, plural, one {{shown} PDF added to this project: {fresh} imported, {fromLibrary} already in My Library} other {{shown} PDFs added to this project: {fresh} imported, {fromLibrary} already in My Library}}",
    ),
    reference: msg(
      "{count, plural, one {{shown} reference added to this project: {fresh} imported, {fromLibrary} already in My Library} other {{shown} references added to this project: {fresh} imported, {fromLibrary} already in My Library}}",
    ),
  },
} as const satisfies Record<string, Record<Noun, string>>;

/** A PDF added to a source already present: the headline names what, a note only counts. */
const ATTACHED = {
  headline: {
    project: {
      pdf: msg(
        "{count, plural, one {{shown} PDF added to its source, already in this project} other {{shown} PDFs added to their sources, already in this project}}",
      ),
      reference: msg(
        "{count, plural, one {{shown} reference added to its source, already in this project} other {{shown} references added to their sources, already in this project}}",
      ),
    },
    library: {
      pdf: msg(
        "{count, plural, one {{shown} PDF added to its source, already in My Library} other {{shown} PDFs added to their sources, already in My Library}}",
      ),
      reference: msg(
        "{count, plural, one {{shown} reference added to its source, already in My Library} other {{shown} references added to their sources, already in My Library}}",
      ),
    },
  },
  note: {
    project: msg(
      "{count, plural, one {{shown} was added to its source, already in this project} other {{shown} were added to their sources, already in this project}}",
    ),
    library: msg(
      "{count, plural, one {{shown} was added to its source, already in My Library} other {{shown} were added to their sources, already in My Library}}",
    ),
  },
} as const satisfies {
  headline: Record<Place, Record<Noun, string>>;
  note: Record<Place, string>;
};

/** Sources the import found already present, by where they were. */
const PRESENT = {
  here: {
    headline: {
      pdf: msg(
        "{count, plural, one {{shown} PDF was already in this project} other {{shown} PDFs were already in this project}}",
      ),
      reference: msg(
        "{count, plural, one {{shown} reference was already in this project} other {{shown} references were already in this project}}",
      ),
    },
    note: msg(
      "{count, plural, one {{shown} was already in this project} other {{shown} were already in this project}}",
    ),
  },
  pinned: {
    headline: {
      pdf: msg(
        "{count, plural, one {{shown} PDF was already in My Library and is in this project now} other {{shown} PDFs were already in My Library and are in this project now}}",
      ),
      reference: msg(
        "{count, plural, one {{shown} reference was already in My Library and is in this project now} other {{shown} references were already in My Library and are in this project now}}",
      ),
    },
    note: msg(
      "{count, plural, one {{shown} was already in My Library and is in this project now} other {{shown} were already in My Library and are in this project now}}",
    ),
  },
  inLibrary: {
    headline: {
      pdf: msg(
        "{count, plural, one {{shown} PDF was already in My Library} other {{shown} PDFs were already in My Library}}",
      ),
      reference: msg(
        "{count, plural, one {{shown} reference was already in My Library} other {{shown} references were already in My Library}}",
      ),
    },
    note: msg(
      "{count, plural, one {{shown} was already in My Library} other {{shown} were already in My Library}}",
    ),
  },
} as const satisfies Record<string, { headline: Record<Noun, string>; note: string }>;

const REVIEW_NOTES = {
  project: msg(
    "{count, plural, one {{shown} may already be in this project and was not imported} other {{shown} may already be in this project and were not imported}}",
  ),
  library: msg(
    "{count, plural, one {{shown} may already be in My Library and was not imported} other {{shown} may already be in My Library and were not imported}}",
  ),
} as const satisfies Record<Place, string>;

/** What a finished import did, counted from its items, with the reference file's exceptions. */
export function describeImport(
  input: ImportReceiptInput,
  resolve: MessageResolver = m,
): ImportReceipt {
  const { operation, outcome, referenceFile } = input;
  const target: ImportTarget = !operation
    ? input.target
    : operation.formatVersion === 1
      ? "project-folder"
      : operation.pinInstanceId
        ? "project"
        : "library";
  const noun: Noun = (operation?.intake ?? input.intake) === "local-pdf" ? "pdf" : "reference";
  const pdfs = noun === "pdf";
  const place: Place = target === "project-folder" ? "project" : "library";
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
      failures.push(item.message ?? resolve(IMPORT_LABELS.itemFailed));
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
    { count: here, copy: PRESENT.here },
    { count: pinned, copy: PRESENT.pinned },
    { count: inLibrary, copy: PRESENT.inLibrary },
  ].filter((entry) => entry.count > 0);

  const notes: string[] = [];
  let headline: string;
  const added = fresh + fromLibrary;
  if (referenceFile && referenceFile.report.entryCount === 0) {
    headline = resolve(IMPORT_LABELS.noReferences, { name: referenceFile.name });
  } else if (added > 0) {
    headline =
      target === "library"
        ? resolve(ADDED_HEADLINES.library[noun], amount(fresh))
        : fromLibrary === 0
          ? resolve(ADDED_HEADLINES.project[noun], amount(fresh))
          : fresh === 0
            ? resolve(ADDED_HEADLINES.fromLibrary[noun], amount(fromLibrary))
            : resolve(ADDED_HEADLINES.mixed[noun], {
                ...amount(added),
                fresh: fresh.toLocaleString(),
                fromLibrary: fromLibrary.toLocaleString(),
              });
  } else if (attached > 0) {
    headline = resolve(ATTACHED.headline[place][noun], amount(attached));
  } else if (present.length > 0) {
    const [first] = present.splice(0, 1);
    headline = resolve(first!.copy.headline[noun], amount(first!.count));
  } else if (operation?.state === "cancelled") {
    headline = resolve(IMPORT_LABELS.stoppedBeforeAnything);
  } else {
    headline = referenceFile
      ? resolve(IMPORT_LABELS.nothingFrom, { name: referenceFile.name })
      : resolve(IMPORT_LABELS.nothing);
  }
  if (added > 0 && attached > 0) {
    notes.push(resolve(ATTACHED.note[place], amount(attached)));
  }
  notes.push(...present.map((entry) => resolve(entry.copy.note, amount(entry.count))));
  // What a PDF import could not find is said here, not left for the person to come across.
  const toCheck = pdfs && input.detailsMissing ? freshIds.filter(input.detailsMissing) : [];
  if (toCheck.length > 0) {
    notes.push(resolve(IMPORT_LABELS.toCheck, amount(toCheck.length)));
  }
  // Kept as its own source; Possible duplicates offers the merge.
  const versions = input.hasOtherVersion ? freshIds.filter(input.hasOtherVersion).length : 0;
  if (versions > 0) {
    notes.push(resolve(IMPORT_LABELS.versions, amount(versions)));
  }
  const file =
    referenceFile && referenceFile.report.entryCount > 0
      ? referenceFileNotes(
          {
            report: referenceFile.report,
            items,
            sourceTitle: input.sourceTitle,
          },
          resolve,
        )
      : { notes: [], details: [] };
  notes.push(...file.notes);
  if (review > 0) notes.push(resolve(REVIEW_NOTES[place], amount(review)));
  if (failed > 0) notes.push(resolve(IMPORT_LABELS.failed, amount(failed)));
  if (unprocessed > 0) notes.push(resolve(IMPORT_LABELS.unprocessed, amount(unprocessed)));
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
