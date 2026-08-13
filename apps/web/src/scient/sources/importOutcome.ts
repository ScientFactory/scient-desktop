import type { ScientSourceImportOperation, ScientSourcesPreflightResult } from "@t3tools/contracts";

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

export const EMPTY_IMPORT_COUNTS: ScientSourcesImportCounts = {
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
    if (isExactSourceDuplicate(item.duplicate.kind)) alreadyPresent += 1;
    if (
      item.duplicate.kind === "possible-metadata-match" &&
      !selectedItemKeys.has(item.candidate.sourceKey)
    ) {
      reviewRequired += 1;
    }
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
