import {
  ScientSourceZoteroRefreshField,
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
  type ScientSourceCreator,
  type ScientSourceEditableMetadata,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourceRecord,
  type ScientSourceZoteroConflict,
  type ScientSourceZoteroSync,
  scientSourceMoreLabel,
} from "@scientfactory/scient-sources";

import type { ZoteroItemMaterial, ZoteroNoteOriginal } from "./ZoteroItems.ts";

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
  /** The further details taken from Zotero, by name; `takenFields` then has `more`. */
  readonly takenMore: ReadonlySet<string>;
  readonly note: { readonly value: string | null } | null;
  readonly conflicts: ReadonlyArray<ZoteroFieldConflict>;
  /** The merge base to store: Zotero's values, except for conflicts still open. */
  readonly base: {
    readonly metadata: ScientSourceEditableMetadata;
    readonly note: string | null;
    /** Zotero's notes as it wrote them; absent while a clash on an earlier import's note is open. */
    readonly notes?: ReadonlyArray<ZoteroNoteOriginal>;
  };
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

function editedHere(record: ScientSourceRecord, field: string): boolean {
  return record.fieldProvenance.some(
    (entry) =>
      (entry.field === field ||
        (field === "identifiers" && entry.field.startsWith("identifiers."))) &&
      (entry.origin === "user" || entry.origin === "agent"),
  );
}

type More = Readonly<Record<string, string>>;

/**
 * The same three-way rule for the further details, each on its own: an edit of the edition
 * here does not hold back a place of publication Zotero added. A detail Zotero lacks never
 * clears one here, and one cleared here stays cleared while Zotero's is unchanged.
 */
function mergeMore(input: {
  readonly record: ScientSourceRecord;
  readonly local: More;
  readonly zotero: More;
  /** Undefined for a source last read before these details were kept. */
  readonly base: More | undefined;
  readonly useZotero: boolean;
  readonly keepLocal: boolean;
}): {
  readonly merged: More;
  readonly taken: ReadonlyArray<string>;
  readonly conflicting: ReadonlyArray<string>;
  readonly base: More;
} {
  const merged: Record<string, string> = { ...input.local };
  const base: Record<string, string> = { ...input.zotero };
  const taken: string[] = [];
  const conflicting: string[] = [];
  for (const [name, zoteroValue] of Object.entries(input.zotero)) {
    const localValue = input.local[name];
    if (localValue === zoteroValue) continue;
    const baseValue = input.base?.[name];
    const zoteroChanged = input.base === undefined || baseValue !== zoteroValue;
    // What Zotero did not change is never taken, also on "Use Zotero's": that choice
    // settles the details that clash, it does not undo a removal made here.
    if (!zoteroChanged) continue;
    if (!input.useZotero && editedHere(input.record, `more.${name}`)) {
      if (!input.keepLocal) {
        conflicting.push(name);
        // Left as it was, so the difference is reported again until it is settled.
        if (baseValue !== undefined) base[name] = baseValue;
        else if (localValue !== undefined) base[name] = localValue;
        else delete base[name];
      }
      continue;
    }
    merged[name] = zoteroValue;
    taken.push(name);
  }
  return { merged, taken, conflicting, base };
}

const shownMore = (more: More, names: ReadonlyArray<string>) =>
  shorten(
    names.map((name) => `${scientSourceMoreLabel(name)}: ${more[name] ?? "(none)"}`).join("; "),
  );

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
  readonly zotero: Pick<ZoteroItemMaterial, "candidate" | "note" | "notes" | "legacyNote">;
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
  const more = mergeMore({
    record: input.record,
    local: local.more ?? {},
    zotero: zotero.more ?? {},
    base: base?.more,
    useZotero: useZotero.has("more"),
    keepLocal: keepLocal.has("more"),
  });
  if (more.taken.length > 0) {
    metadata.more = more.merged;
    takenFields.add("more");
  }
  if (more.conflicting.length > 0) {
    conflicts.push({
      field: "more",
      local: shownMore(local.more ?? {}, more.conflicting),
      zotero: shownMore(zotero.more ?? {}, more.conflicting),
    });
  }
  baseMetadata.more = more.base;

  for (const field of ZOTERO_REFRESH_FIELDS) {
    if (field === "note" || field === "more") continue;
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
  const { legacyNote } = input.zotero;
  let note: { readonly value: string | null } | null = null;
  let planBase: ZoteroRefreshPlan["base"] = {
    metadata: baseMetadata as ScientSourceEditableMetadata,
    note: zoteroNote,
    notes: input.zotero.notes,
  };
  if (zoteroNote !== null && localNote !== zoteroNote) {
    // Untouched: still the text Scient last wrote from Zotero. Without a base that is an
    // earlier import's plain text, or no note at all.
    const untouched = input.base
      ? localNote === input.base.note
      : localNote === null || localNote === legacyNote;
    // Asked of Zotero's own HTML, never of a conversion: a better converter is not a change.
    const zoteroChanged = !input.base
      ? true
      : input.base.notes
        ? !same(input.base.notes, input.zotero.notes) && zoteroNote !== input.base.note
        : legacyNote !== input.base.note;
    if (useZotero.has("note") || untouched) {
      note = { value: zoteroNote };
    } else if (zoteroChanged && !keepLocal.has("note")) {
      conflicts.push({
        field: "note",
        local: displayZoteroFieldValue("note", localNote),
        zotero: displayZoteroFieldValue("note", zoteroNote),
      });
      // Left as it was, so the clash is reported again; never the note here, which would
      // read as untouched next time and be replaced.
      planBase = {
        metadata: planBase.metadata,
        note: input.base ? input.base.note : null,
        ...(input.base?.notes ? { notes: input.base.notes } : {}),
      };
    }
  }

  return {
    metadata: metadata as ScientSourceEditableMetadata,
    takenFields,
    takenMore: new Set(more.taken),
    note,
    conflicts,
    base: planBase,
  };
}

/** The record's provenance with Zotero's entries for the fields a refresh took. */
export function refreshedFieldProvenance(input: {
  readonly current: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly zotero: ReadonlyArray<ScientSourceFieldProvenance>;
  readonly takenFields: ReadonlySet<string>;
}): ReadonlyArray<ScientSourceFieldProvenance> {
  // A further detail has a line of its own (`more.edition`); `more` as a whole has none.
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
