import type {
  ScientSourceCandidate,
  ScientSourceEditableMetadata,
  ScientSourceMetadataDiagnostic,
  ScientSourceRecord,
  ScientSourceType,
} from "./model.ts";

const ZOTERO_TYPE_MAP: Readonly<Record<string, ScientSourceType>> = {
  journalArticle: "article",
  magazineArticle: "article",
  newspaperArticle: "article",
  preprint: "preprint",
  book: "book",
  bookSection: "book-chapter",
  conferencePaper: "conference-paper",
  thesis: "thesis",
  report: "report",
  dataset: "dataset",
  webpage: "web",
  blogPost: "web",
  forumPost: "web",
};

export function scientSourceTypeFromZotero(itemType: string): ScientSourceType {
  return ZOTERO_TYPE_MAP[itemType] ?? "other";
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

export function sourceMetadataDiagnostics(
  source: ScientSourceCandidate | ScientSourceRecord,
): ReadonlyArray<ScientSourceMetadataDiagnostic> {
  const diagnostics: ScientSourceMetadataDiagnostic[] = [];
  if (!source.title?.trim()) {
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
      .replace(/\s+/gu, "");
  }
  return `${normalizedScheme}:${normalizedValue}`;
}
