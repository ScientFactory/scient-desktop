import type {
  ScientSourceCreator,
  ScientSourceEditableMetadata,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceMetadataValidationIssue,
  ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";

export const SCIENT_SOURCE_EDITABLE_FIELDS = [
  "type",
  "customType",
  "title",
  "creators",
  "issuedRaw",
  "issuedYear",
  "identifiers",
  "abstract",
  "containerTitle",
  "publisher",
  "volume",
  "issue",
  "pages",
  "language",
  "url",
  "tags",
] as const;

export type ScientSourceEditableField = (typeof SCIENT_SOURCE_EDITABLE_FIELDS)[number];

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCreator(creator: ScientSourceCreator): ScientSourceCreator | null {
  const givenName = nullableText(creator.givenName);
  const familyName = nullableText(creator.familyName);
  const literalName = nullableText(creator.literalName);
  if (!givenName && !familyName && !literalName) return null;
  return {
    creatorType: creator.creatorType.trim(),
    givenName,
    familyName,
    literalName,
  };
}

function normalizeIdentifier(identifier: ScientSourceIdentifier): ScientSourceIdentifier {
  const scheme = identifier.scheme.trim().toLowerCase();
  let value = identifier.value.trim();
  if (scheme === "doi") {
    value = value
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
      .replace(/^doi:\s*/iu, "")
      .toLowerCase();
  }
  return { scheme, value };
}

export function editableMetadataFromRecord(
  record: ScientSourceRecord,
): ScientSourceEditableMetadata {
  return {
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
  };
}

export function normalizeScientSourceEditableMetadata(
  metadata: ScientSourceEditableMetadata,
): ScientSourceEditableMetadata {
  const identifiers: ScientSourceIdentifier[] = [];
  const seenIdentifiers = new Set<string>();
  for (const rawIdentifier of metadata.identifiers) {
    const identifier = normalizeIdentifier(rawIdentifier);
    const key = normalizePersistentIdentifier(identifier.scheme, identifier.value);
    if (seenIdentifiers.has(key)) continue;
    seenIdentifiers.add(key);
    identifiers.push(identifier);
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const rawTag of metadata.tags) {
    const tag = rawTag.trim();
    if (!tag || seenTags.has(tag)) continue;
    seenTags.add(tag);
    tags.push(tag);
  }

  return {
    type: metadata.type,
    customType: metadata.type === "other" ? nullableText(metadata.customType) : null,
    title: nullableText(metadata.title),
    creators: metadata.creators.flatMap((creator) => {
      const normalized = normalizeCreator(creator);
      return normalized ? [normalized] : [];
    }),
    issuedRaw: nullableText(metadata.issuedRaw),
    issuedYear: metadata.issuedYear,
    identifiers,
    abstract: nullableText(metadata.abstract),
    containerTitle: nullableText(metadata.containerTitle),
    publisher: nullableText(metadata.publisher),
    volume: nullableText(metadata.volume),
    issue: nullableText(metadata.issue),
    pages: nullableText(metadata.pages),
    language: nullableText(metadata.language),
    url: nullableText(metadata.url),
    tags,
  };
}

export function validateScientSourceEditableMetadata(
  metadata: ScientSourceEditableMetadata,
): ReadonlyArray<ScientSourceMetadataValidationIssue> {
  const issues: ScientSourceMetadataValidationIssue[] = [];
  if (metadata.type === "other" && !metadata.customType?.trim()) {
    issues.push({ field: "customType", message: "Enter the source type." });
  }
  for (const [index, creator] of metadata.creators.entries()) {
    if (!creator.creatorType.trim()) {
      issues.push({ field: `creators.${index}.creatorType`, message: "Creator role is required." });
    }
  }
  for (const [index, identifier] of metadata.identifiers.entries()) {
    if (!identifier.scheme.trim() || !identifier.value.trim()) {
      issues.push({
        field: `identifiers.${index}`,
        message: "Every identifier needs a type and value.",
      });
    }
  }
  if (metadata.issuedYear !== null && (metadata.issuedYear < 1000 || metadata.issuedYear > 9999)) {
    issues.push({ field: "issuedYear", message: "Enter a four-digit publication year." });
  }
  if (metadata.url) {
    try {
      const url = new URL(metadata.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push({ field: "url", message: "Enter an HTTP or HTTPS source URL." });
      }
    } catch {
      issues.push({ field: "url", message: "Enter a valid source URL." });
    }
  }
  return issues;
}

export function editableMetadataEquals(
  left: ScientSourceEditableMetadata,
  right: ScientSourceEditableMetadata,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function changedEditableMetadataFields(
  previous: ScientSourceEditableMetadata,
  next: ScientSourceEditableMetadata,
): ReadonlyArray<ScientSourceEditableField> {
  return SCIENT_SOURCE_EDITABLE_FIELDS.filter(
    (field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]),
  );
}

function belongsToChangedField(
  provenance: ScientSourceFieldProvenance,
  changed: ReadonlySet<ScientSourceEditableField>,
): boolean {
  if (changed.has(provenance.field as ScientSourceEditableField)) return true;
  return provenance.field.startsWith("identifiers.") && changed.has("identifiers");
}

export function applyEditableMetadata(input: {
  readonly record: ScientSourceRecord;
  readonly metadata: ScientSourceEditableMetadata;
  readonly updatedAt: string;
}): ScientSourceRecord {
  const previous = normalizeScientSourceEditableMetadata(editableMetadataFromRecord(input.record));
  const next = normalizeScientSourceEditableMetadata(input.metadata);
  const changed = changedEditableMetadataFields(previous, next);
  const changedSet = new Set(changed);
  const fieldProvenance = input.record.fieldProvenance.filter(
    (entry) => !belongsToChangedField(entry, changedSet),
  );
  fieldProvenance.push(
    ...changed.map((field) => ({ field, origin: "user" as const, sourceField: null })),
  );
  return {
    ...input.record,
    ...next,
    revision: input.record.revision + 1,
    fieldProvenance,
    updatedAt: input.updatedAt,
  };
}
