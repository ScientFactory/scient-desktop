import type {
  ScientSourceActor,
  ScientSourceCreator,
  ScientSourceEditableMetadata,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceMetadataValidationIssue,
  ScientSourceRecord,
} from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";
import {
  isScientSourceMoreName,
  normalizeScientSourceMore,
  scientSourceMoreLabel,
} from "./sourceMore.ts";
import { normalizeScientSourceAbstract } from "./abstract.ts";
import { normalizeScientSourceAbstractDocument } from "./abstract.ts";
import { CITATION_KEY_SYNTAX_MESSAGE, isValidCitationKey } from "./citationKeys.ts";

const SCIENT_SOURCE_EDITABLE_FIELDS = [
  "citationKey",
  "type",
  "customType",
  "title",
  "creators",
  "incompleteCreatorRoles",
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
  "more",
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
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    incompleteCreatorRoles: record.incompleteCreatorRoles ?? [],
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
    more: record.more ?? {},
  };
}

/** The marked roles that still have names, each once, in the creators' spelling. */
function normalizeIncompleteRoles(
  roles: ReadonlyArray<string>,
  creators: ReadonlyArray<ScientSourceCreator>,
): string[] {
  const named = new Map(
    creators.map((creator) => [creator.creatorType.toLowerCase(), creator.creatorType]),
  );
  return [...new Set(roles.flatMap((role) => named.get(role.trim().toLowerCase()) ?? []))];
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

  const creators = metadata.creators.flatMap((creator) => {
    const normalized = normalizeCreator(creator);
    return normalized ? [normalized] : [];
  });
  return {
    ...(metadata.citationKey === undefined
      ? {}
      : { citationKey: metadata.citationKey.normalize("NFC").trim() }),
    type: metadata.type,
    customType: metadata.type === "other" ? nullableText(metadata.customType) : null,
    title: nullableText(metadata.title),
    creators,
    ...(metadata.incompleteCreatorRoles === undefined
      ? {}
      : {
          incompleteCreatorRoles: normalizeIncompleteRoles(
            metadata.incompleteCreatorRoles,
            creators,
          ),
        }),
    issuedRaw: nullableText(metadata.issuedRaw),
    issuedYear: metadata.issuedYear,
    identifiers,
    abstract: normalizeScientSourceAbstract(metadata.abstract),
    containerTitle: nullableText(metadata.containerTitle),
    publisher: nullableText(metadata.publisher),
    volume: nullableText(metadata.volume),
    issue: nullableText(metadata.issue),
    pages: nullableText(metadata.pages),
    language: nullableText(metadata.language),
    url: nullableText(metadata.url),
    tags,
    // An entry that would not fit is refused by validation, so nothing is dropped here.
    ...(metadata.more === undefined
      ? {}
      : { more: normalizeScientSourceMore(metadata.more).more ?? {} }),
  };
}

export function validateScientSourceEditableMetadata(
  metadata: ScientSourceEditableMetadata,
): ReadonlyArray<ScientSourceMetadataValidationIssue> {
  const issues: ScientSourceMetadataValidationIssue[] = [];
  if (metadata.citationKey !== undefined && !isValidCitationKey(metadata.citationKey)) {
    issues.push({
      field: "citationKey",
      message: CITATION_KEY_SYNTAX_MESSAGE,
    });
  }
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
  for (const name of normalizeScientSourceMore(metadata.more).left) {
    issues.push({
      field: `more.${name}`,
      message: isScientSourceMoreName(name)
        ? `${scientSourceMoreLabel(name)} is too long to keep.`
        : "This detail has no name Scient knows.",
    });
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

/** `next` without a citation key keeps the current key, so it never counts as a change. */
export function changedEditableMetadataFields(
  previous: ScientSourceEditableMetadata,
  next: ScientSourceEditableMetadata,
): ReadonlyArray<ScientSourceEditableField> {
  return SCIENT_SOURCE_EDITABLE_FIELDS.filter((field) => {
    if (field === "citationKey" && next.citationKey === undefined) return false;
    if (field === "more" && next.more === undefined) return false;
    if (field === "incompleteCreatorRoles") {
      return (
        next.incompleteCreatorRoles !== undefined &&
        JSON.stringify(previous.incompleteCreatorRoles ?? []) !==
          JSON.stringify(next.incompleteCreatorRoles)
      );
    }
    return JSON.stringify(previous[field] ?? {}) !== JSON.stringify(next[field] ?? {});
  });
}

export function editableMetadataEquals(
  previous: ScientSourceEditableMetadata,
  next: ScientSourceEditableMetadata,
): boolean {
  return changedEditableMetadataFields(previous, next).length === 0;
}

function belongsToChangedField(
  provenance: ScientSourceFieldProvenance,
  changed: ReadonlySet<ScientSourceEditableField>,
): boolean {
  if (changed.has(provenance.field as ScientSourceEditableField)) return true;
  return provenance.field.startsWith("identifiers.") && changed.has("identifiers");
}

/** The further details whose text differs between two versions, by name. */
function changedMoreNames(
  previous: ScientSourceEditableMetadata,
  next: ScientSourceEditableMetadata,
): ReadonlyArray<string> {
  if (next.more === undefined) return [];
  const [before, after] = [previous.more ?? {}, next.more];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
}

export function applyEditableMetadata(input: {
  readonly record: ScientSourceRecord;
  readonly metadata: ScientSourceEditableMetadata;
  readonly updatedAt: string;
  readonly actor?: ScientSourceActor;
}): ScientSourceRecord {
  const actor = input.actor ?? "user";
  const previous = normalizeScientSourceEditableMetadata(editableMetadataFromRecord(input.record));
  const next = normalizeScientSourceEditableMetadata(input.metadata);
  const changed = changedEditableMetadataFields(previous, next);
  const changedSet = new Set(changed);
  // Each further detail has its own line: who last set or cleared it, apart from the others.
  const moreNames = new Set(changedMoreNames(previous, next).map((name) => `more.${name}`));
  const fieldProvenance = input.record.fieldProvenance.filter(
    (entry) => !belongsToChangedField(entry, changedSet) && !moreNames.has(entry.field),
  );
  // An incomplete list is part of the creators; it has no provenance line of its own.
  fieldProvenance.push(
    ...changed
      .filter((field) => field !== "more" && field !== "incompleteCreatorRoles")
      .map((field) => ({ field, origin: actor, sourceField: null })),
    ...[...moreNames].map((field) => ({ field, origin: actor, sourceField: null })),
  );
  const abstractChanged = changedSet.has("abstract");
  const abstract = abstractChanged ? normalizeScientSourceAbstractDocument(next.abstract) : null;
  // The further details are replaced as a whole when given; none left means the part goes.
  const { more: nextMore, incompleteCreatorRoles: nextIncomplete, ...nextFields } = next;
  const { more: _currentMore, ...withoutMore } = input.record;
  const kept =
    nextMore === undefined
      ? input.record
      : Object.keys(nextMore).length > 0
        ? { ...withoutMore, more: nextMore }
        : withoutMore;
  const { incompleteCreatorRoles: _currentIncomplete, ...withoutIncomplete } = kept;
  const marked =
    nextIncomplete === undefined
      ? kept
      : nextIncomplete.length > 0
        ? { ...withoutIncomplete, incompleteCreatorRoles: nextIncomplete }
        : withoutIncomplete;
  const updated = {
    ...marked,
    ...nextFields,
    revision: input.record.revision + 1,
    fieldProvenance,
    updatedAt: input.updatedAt,
    updatedBy: actor,
  };
  if (!abstractChanged) return updated;
  if (abstract) return { ...updated, abstractSections: [...abstract.sections] };
  const { abstractSections: _removedAbstractSections, ...withoutAbstractSections } = updated;
  return withoutAbstractSections;
}
