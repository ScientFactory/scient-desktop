import {
  ScientSourceZoteroRefreshField,
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceEditableMetadata,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourceRecord,
  type ScientSourceZoteroConflict,
  type ScientSourceZoteroSync,
} from "@scientfactory/scient-sources";

const ZOTERO_REFRESH_FIELDS = ScientSourceZoteroRefreshField.literals;
type ZoteroRefreshField = ScientSourceZoteroRefreshField;
type MetadataField = Exclude<ZoteroRefreshField, "note">;

type ZoteroFieldConflict = ScientSourceZoteroConflict;

export interface ZoteroRefreshChoices {
  /** Take Zotero's value even where it was edited here. */
  readonly useZotero?: ReadonlySet<ZoteroRefreshField>;
  /** Keep this source's value and stop reporting the difference. */
  readonly keepLocal?: ReadonlySet<ZoteroRefreshField>;
}

export interface ZoteroRefreshPlan {
  readonly metadata: ScientSourceEditableMetadata;
  readonly takenFields: ReadonlySet<MetadataField>;
  readonly note: { readonly value: string | null } | null;
  readonly conflicts: ReadonlyArray<ZoteroFieldConflict>;
  /** The merge base to store: Zotero's values, except for conflicts still open. */
  readonly base: { readonly metadata: ScientSourceEditableMetadata; readonly note: string | null };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

const SHOWN_LENGTH = 200;
const shorten = (value: string) =>
  value.length > SHOWN_LENGTH ? `${value.slice(0, SHOWN_LENGTH - 1)}…` : value;

function creatorName(creator: ScientSourceCreator): string {
  if (creator.literalName) return creator.literalName;
  return [creator.familyName, creator.givenName].filter(Boolean).join(", ");
}

/** A short, readable form of a field value for a conflict report. */
function displayZoteroFieldValue(field: ZoteroRefreshField, value: unknown): string {
  if (isEmpty(value)) return "";
  if (field === "creators") {
    return shorten((value as ReadonlyArray<ScientSourceCreator>).map(creatorName).join("; "));
  }
  if (field === "identifiers") {
    return shorten(
      (value as ReadonlyArray<ScientSourceIdentifier>)
        .map((identifier) => `${identifier.scheme.toUpperCase()} ${identifier.value}`)
        .join(", "),
    );
  }
  if (field === "tags") return shorten((value as ReadonlyArray<string>).join(", "));
  return shorten(String(value));
}

function editedHere(record: ScientSourceRecord, field: MetadataField): boolean {
  return record.fieldProvenance.some(
    (entry) =>
      (entry.field === field ||
        (field === "identifiers" && entry.field.startsWith("identifiers."))) &&
      (entry.origin === "user" || entry.origin === "agent"),
  );
}

function mergeTags(input: {
  readonly local: ReadonlyArray<string>;
  readonly zotero: ReadonlyArray<string>;
  readonly base: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const zotero = new Set(input.zotero);
  const removed = new Set((input.base ?? []).filter((tag) => !zotero.has(tag)));
  const added = input.zotero.filter((tag) => !(input.base ?? []).includes(tag));
  const merged = input.local.filter((tag) => !removed.has(tag));
  for (const tag of added) if (!merged.includes(tag)) merged.push(tag);
  return merged;
}

/**
 * Three-way merge of one source with its Zotero item. Zotero's change wins where the field
 * was not edited here; an edit here is kept and reported. An empty Zotero value never
 * clears one here, and tags merge as additions and removals.
 */
export function planZoteroRefresh(input: {
  readonly record: ScientSourceRecord;
  readonly base: ScientSourceZoteroSync | null;
  readonly zotero: { readonly candidate: ScientSourceCandidate; readonly note: string | null };
  readonly choices?: ZoteroRefreshChoices;
}): ZoteroRefreshPlan {
  const { citationKey: _key, ...local } = normalizeScientSourceEditableMetadata(
    editableMetadataFromRecord(input.record),
  );
  const { citationKey: _zoteroKey, ...zotero } = normalizeScientSourceEditableMetadata({
    ...input.zotero.candidate,
    customType: input.zotero.candidate.customType ?? null,
  });
  const base = input.base ? normalizeScientSourceEditableMetadata(input.base.metadata) : undefined;
  const useZotero = input.choices?.useZotero ?? new Set();
  const keepLocal = input.choices?.keepLocal ?? new Set();
  const metadata: Record<string, unknown> = { ...local };
  const baseMetadata: Record<string, unknown> = { ...zotero };
  const takenFields = new Set<MetadataField>();
  const conflicts: ZoteroFieldConflict[] = [];

  for (const field of ZOTERO_REFRESH_FIELDS) {
    if (field === "note") continue;
    const localValue = local[field];
    const zoteroValue = zotero[field];
    const baseValue = base?.[field];
    if (same(localValue, zoteroValue)) continue;
    if (field === "tags" && !useZotero.has(field)) {
      const merged = mergeTags({
        local: local.tags,
        zotero: zotero.tags,
        base: base?.tags,
      });
      if (!same(merged, local.tags)) {
        metadata.tags = merged;
        takenFields.add("tags");
      }
      continue;
    }
    const zoteroChanged = baseValue === undefined || !same(baseValue, zoteroValue);
    if (useZotero.has(field) && !isEmpty(zoteroValue)) {
      metadata[field] = zoteroValue;
      takenFields.add(field);
      continue;
    }
    if (!zoteroChanged || isEmpty(zoteroValue)) continue;
    if (!editedHere(input.record, field)) {
      metadata[field] = zoteroValue;
      takenFields.add(field);
      continue;
    }
    if (keepLocal.has(field)) continue;
    conflicts.push({
      field,
      local: displayZoteroFieldValue(field, localValue),
      zotero: displayZoteroFieldValue(field, zoteroValue),
    });
    baseMetadata[field] = baseValue ?? localValue;
  }

  const localNote = input.record.note ?? null;
  const zoteroNote = input.zotero.note;
  const baseNote = input.base ? input.base.note : undefined;
  let note: { readonly value: string | null } | null = null;
  let storedBaseNote = zoteroNote;
  if (!same(localNote, zoteroNote) && zoteroNote !== null) {
    const zoteroChanged = baseNote === undefined || baseNote !== zoteroNote;
    const noteEditedHere = baseNote === undefined ? localNote !== null : localNote !== baseNote;
    if (useZotero.has("note") || (zoteroChanged && !noteEditedHere)) {
      note = { value: zoteroNote };
    } else if (zoteroChanged && !keepLocal.has("note")) {
      conflicts.push({
        field: "note",
        local: displayZoteroFieldValue("note", localNote),
        zotero: displayZoteroFieldValue("note", zoteroNote),
      });
      storedBaseNote = baseNote ?? localNote;
    }
  }

  return {
    metadata: metadata as ScientSourceEditableMetadata,
    takenFields,
    note,
    conflicts,
    base: {
      metadata: baseMetadata as ScientSourceEditableMetadata,
      note: storedBaseNote,
    },
  };
}

/** The record's provenance with Zotero's entries for the fields a refresh took. */
export function refreshedFieldProvenance(input: {
  readonly current: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly zotero: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly takenFields: ReadonlySet<string>;
}): ReadonlyArray<ScientSourceFieldProvenance> {
  const editable = (field: string) => (field.startsWith("identifiers.") ? "identifiers" : field);
  const taken = (entry: ScientSourceFieldProvenance) =>
    input.takenFields.has(editable(entry.field));
  const zoteroEntries = input.zotero.filter(taken);
  const covered = new Set(zoteroEntries.map((entry) => editable(entry.field)));
  return [
    ...input.current.filter((entry) => !taken(entry)),
    ...zoteroEntries,
    ...[...input.takenFields]
      .filter((field) => !covered.has(field))
      .map((field) => ({ field, origin: "zotero" as const, sourceField: null })),
  ];
}
