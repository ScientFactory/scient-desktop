import type {
  ScientSourceCandidate,
  ScientSourceEditableMetadata,
  ScientSourceFieldProvenance,
  ScientSourceMetadataDiagnostic,
  ScientSourceRecord,
  ScientSourceType,
} from "./model.ts";
import { ZOTERO_TYPE_SOURCE } from "./zoteroSchema.ts";

export function scientSourceTypeFromZotero(itemType: string): ScientSourceType {
  return ZOTERO_TYPE_SOURCE[itemType] ?? "other";
}

function normalized(value: string | null): string {
  return value?.trim().toLowerCase().replace(/\s+/gu, " ") ?? "";
}

export function sourceMetadataKey(
  source: Pick<
    ScientSourceCandidate | ScientSourceEditableMetadata | ScientSourceRecord,
    "creators" | "issuedYear" | "title"
  >,
): string | null {
  const leadCreator = source.creators.at(0);
  const creator =
    leadCreator?.familyName ?? leadCreator?.literalName ?? leadCreator?.givenName ?? "";
  const title = normalized(source.title);
  const normalizedCreator = normalized(creator);
  if (!title || !normalizedCreator || source.issuedYear === null) return null;
  return [title, normalizedCreator, source.issuedYear].join("|");
}

/**
 * Whether two sources say they are different editions, or different versions, of a work. The
 * same title, lead creator and year then do not make them one source. Only where both say
 * which: a source that names no edition may still be the other one.
 */
export function sourceEditionsDiffer(
  left: { readonly more?: Readonly<Record<string, string>> },
  right: { readonly more?: Readonly<Record<string, string>> },
): boolean {
  // "2", "2nd" and "2nd ed." are one edition; a version is compared as it is written.
  const edition = (value: string | undefined) => {
    const text = normalized(value ?? null);
    return text ? (/\d+/u.exec(text)?.[0] ?? text) : null;
  };
  const version = (value: string | undefined) => normalized(value ?? null) || null;
  const differ = (mine: string | null, theirs: string | null) =>
    mine !== null && theirs !== null && mine !== theirs;
  return (
    differ(edition(left.more?.edition), edition(right.more?.edition)) ||
    differ(version(left.more?.version), version(right.more?.version))
  );
}

/** The provenance of a title that is only the file's name, kept until the work's own is found. */
export const SCIENT_SOURCE_FILE_NAME_TITLE = "file-name";

/** A title that names the file, not the work: it shows the source, it says nothing of what it is. */
export function scientSourceTitleIsFileName(source: {
  readonly fieldProvenance?: ReadonlyArray<
    Pick<ScientSourceFieldProvenance, "field" | "sourceField">
  >;
}): boolean {
  return (
    source.fieldProvenance?.some(
      (entry) => entry.field === "title" && entry.sourceField === SCIENT_SOURCE_FILE_NAME_TITLE,
    ) ?? false
  );
}

export function sourceMetadataDiagnostics(
  source: ScientSourceCandidate | ScientSourceRecord,
): ReadonlyArray<ScientSourceMetadataDiagnostic> {
  const diagnostics: ScientSourceMetadataDiagnostic[] = [];
  if (!source.title?.trim() || scientSourceTitleIsFileName(source)) {
    diagnostics.push({ field: "title", severity: "warning", message: "Title wasn’t found." });
  }
  if (source.creators.length === 0) {
    diagnostics.push({
      field: "creators",
      severity: "warning",
      message: "Creator wasn’t found.",
    });
  }
  if (source.issuedYear === null) {
    diagnostics.push({
      field: "issuedYear",
      severity: "info",
      message: "Publication year wasn’t found.",
    });
  }
  if (source.identifiers.length === 0) {
    diagnostics.push({
      field: "identifiers",
      severity: "info",
      message: "Persistent identifier wasn’t found.",
    });
  }
  if (
    source.fieldProvenance.some(
      (entry) => entry.origin === "local-pdf" && entry.sourceField === "pdf-parser",
    )
  ) {
    diagnostics.push({
      field: "metadata",
      severity: "warning",
      message: "PDF metadata couldn’t be extracted. Review the source details and add it manually.",
    });
  }
  return diagnostics;
}

export function normalizePersistentIdentifier(scheme: string, value: string): string {
  const normalizedScheme = scheme.trim().toLowerCase();
  let normalizedValue = value.trim().toLowerCase();
  if (normalizedScheme === "doi") {
    normalizedValue = normalizedValue
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "")
      .replace(/^doi:\s*/u, "");
  } else if (normalizedScheme === "isbn" || normalizedScheme === "issn") {
    normalizedValue = normalizedValue.replace(/[\s-]+/gu, "");
  } else if (normalizedScheme === "pmid") {
    normalizedValue = normalizedValue.replace(/^pmid:\s*/u, "").replace(/\s+/gu, "");
  } else if (normalizedScheme === "pmcid") {
    normalizedValue = normalizedValue.replace(/^pmcid:\s*/u, "").replace(/\s+/gu, "");
  } else if (normalizedScheme === "arxiv") {
    normalizedValue = normalizedValue
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//u, "")
      .replace(/\.pdf$/u, "")
      .replace(/^arxiv:\s*/u, "")
      .replace(/\s+/gu, "")
      .replace(/v\d+$/u, "");
  }
  return `${normalizedScheme}:${normalizedValue}`;
}
