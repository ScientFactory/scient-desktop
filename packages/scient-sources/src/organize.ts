import * as Schema from "effect/Schema";

import {
  ScientSourceActor,
  ScientSourceType,
  type ScientSourceCreator,
  type ScientSourceIdentifier,
} from "./model.ts";

const NonEmptyString = Schema.String.check(
  Schema.isTrimmed({ toJsonSchema: () => [{}, true] }),
  Schema.isNonEmpty(),
);
const Name = NonEmptyString.check(Schema.isMaxLength(200));
const Tag = NonEmptyString.check(Schema.isMaxLength(200));

export const SCIENT_SOURCE_COLLECTION_LIMIT = 500;
export const SCIENT_SOURCE_SAVED_SEARCH_LIMIT = 200;
export const SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT = 20_000;

/** One way of narrowing the Library, shared by the panel, saved searches and agent tools. */
export const ScientSourceFilter = Schema.Struct({
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  tags: Schema.optionalKey(Schema.Array(Tag).pipe(Schema.check(Schema.isMaxLength(50)))),
  collectionId: Schema.optionalKey(NonEmptyString),
  type: Schema.optionalKey(ScientSourceType),
  hasPdf: Schema.optionalKey(Schema.Boolean),
});
export type ScientSourceFilter = typeof ScientSourceFilter.Type;

export const ScientSourceCollection = Schema.Struct({
  collectionId: NonEmptyString,
  name: Name,
  // Ids stay when a source is removed, so restoring it from the trash restores membership too.
  sourceIds: Schema.Array(NonEmptyString).pipe(
    Schema.check(Schema.isMaxLength(SCIENT_SOURCE_COLLECTION_MEMBER_LIMIT)),
  ),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
  deletedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceCollection = typeof ScientSourceCollection.Type;

export const ScientSourceSavedSearch = Schema.Struct({
  searchId: NonEmptyString,
  name: Name,
  filter: ScientSourceFilter,
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
  deletedAt: Schema.optionalKey(NonEmptyString),
});
export type ScientSourceSavedSearch = typeof ScientSourceSavedSearch.Type;

export const ScientSourceCollectionsDocument = Schema.Struct({
  formatVersion: Schema.Literal(1),
  collections: Schema.Array(ScientSourceCollection),
  savedSearches: Schema.Array(ScientSourceSavedSearch),
});
export type ScientSourceCollectionsDocument = typeof ScientSourceCollectionsDocument.Type;

export const ScientSourceCollectionSummary = Schema.Struct({
  collectionId: NonEmptyString,
  name: Name,
  sourceIds: Schema.Array(NonEmptyString),
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
});
export type ScientSourceCollectionSummary = typeof ScientSourceCollectionSummary.Type;

export const ScientSourceSavedSearchSummary = Schema.Struct({
  searchId: NonEmptyString,
  name: Name,
  filter: ScientSourceFilter,
  updatedAt: NonEmptyString,
  updatedBy: ScientSourceActor,
});
export type ScientSourceSavedSearchSummary = typeof ScientSourceSavedSearchSummary.Type;

/** What clients and agents see: live entries only, members limited to sources that exist. */
export const ScientSourcesOrganization = Schema.Struct({
  collections: Schema.Array(ScientSourceCollectionSummary),
  savedSearches: Schema.Array(ScientSourceSavedSearchSummary),
  issue: Schema.optionalKey(Schema.String),
});
export type ScientSourcesOrganization = typeof ScientSourcesOrganization.Type;

const SourceIds = Schema.Array(NonEmptyString).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
);
const CollectionIds = Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMaxLength(50)));
const Tags = Schema.Array(Tag).pipe(Schema.check(Schema.isMaxLength(50)));

/** One change to collections or saved searches, the same for people and agents. */
export const ScientSourcesOrganizeAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create-collection"),
    name: Name,
    sourceIds: Schema.optionalKey(SourceIds),
  }),
  Schema.Struct({
    action: Schema.Literal("rename-collection"),
    collectionId: NonEmptyString,
    name: Name,
  }),
  Schema.Struct({ action: Schema.Literal("delete-collection"), collectionId: NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("restore-collection"), collectionId: NonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("add-to-collection"),
    collectionId: NonEmptyString,
    sourceIds: SourceIds,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-from-collection"),
    collectionId: NonEmptyString,
    sourceIds: SourceIds,
  }),
  Schema.Struct({
    action: Schema.Literal("save-search"),
    name: Name,
    filter: ScientSourceFilter,
    searchId: Schema.optionalKey(NonEmptyString),
  }),
  Schema.Struct({ action: Schema.Literal("delete-search"), searchId: NonEmptyString }),
]);
export type ScientSourcesOrganizeAction = typeof ScientSourcesOrganizeAction.Type;

export const ScientSourcesOrganizeResult = Schema.Struct({
  outcome: Schema.Literals([
    "created",
    "existing",
    "renamed",
    "updated",
    "unchanged",
    "deleted",
    "restored",
    "not-found",
    "name-taken",
  ]),
  collection: Schema.optionalKey(ScientSourceCollectionSummary),
  savedSearch: Schema.optionalKey(ScientSourceSavedSearchSummary),
  addedSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  removedSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  unknownSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
});
export type ScientSourcesOrganizeResult = typeof ScientSourcesOrganizeResult.Type;

/** Changes applied to many sources at once. Tag and type edits make a revision per source. */
export const ScientSourcesBulkChange = Schema.Struct({
  sourceIds: SourceIds,
  addTags: Schema.optionalKey(Tags),
  removeTags: Schema.optionalKey(Tags),
  type: Schema.optionalKey(ScientSourceType),
  customType: Schema.optionalKey(NonEmptyString.check(Schema.isMaxLength(200))),
  addToCollectionIds: Schema.optionalKey(CollectionIds),
  removeFromCollectionIds: Schema.optionalKey(CollectionIds),
});
export type ScientSourcesBulkChange = typeof ScientSourcesBulkChange.Type;

/** Reverses one earlier bulk edit by the `undo.batchId` its result returned. */
export const ScientSourcesBulkUndo = Schema.Struct({ undoBatchId: NonEmptyString });
export type ScientSourcesBulkUndo = typeof ScientSourcesBulkUndo.Type;

export const ScientSourcesBulkRequestChange = Schema.Union([
  ScientSourcesBulkChange,
  ScientSourcesBulkUndo,
]);
export type ScientSourcesBulkRequestChange = typeof ScientSourcesBulkRequestChange.Type;

const BulkFields = Schema.Struct({
  type: ScientSourceType,
  customType: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
});
export type ScientSourcesBulkFields = typeof BulkFields.Type;

/** What one bulk edit changed, kept so it can be undone as a whole. */
export const ScientSourcesBulkReceipt = Schema.Struct({
  formatVersion: Schema.Literal(1),
  batchId: NonEmptyString,
  createdAt: NonEmptyString,
  actor: ScientSourceActor,
  // Each entry is written as `pending` before its change and cleared once the change is saved;
  // `restoring` is written before Undo puts it back. Undo compares them with the source's
  // revision (a collection's `updatedAt`) to tell whether each write landed. `undoneAt` is set
  // once Undo has dealt with the entry, so a retry skips it.
  sources: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      before: BulkFields,
      after: BulkFields,
      revision: Schema.optionalKey(Schema.Int),
      pending: Schema.optionalKey(Schema.Literal(true)),
      restoring: Schema.optionalKey(Schema.Struct({ revision: Schema.Int, fields: BulkFields })),
      undoneAt: Schema.optionalKey(NonEmptyString),
    }),
  ),
  collections: Schema.Array(
    Schema.Struct({
      collectionId: NonEmptyString,
      addedSourceIds: Schema.Array(NonEmptyString),
      removedSourceIds: Schema.Array(NonEmptyString),
      updatedAt: Schema.optionalKey(NonEmptyString),
      pending: Schema.optionalKey(Schema.Literal(true)),
      restoring: Schema.optionalKey(Schema.Struct({ updatedAt: NonEmptyString })),
      undoneAt: Schema.optionalKey(NonEmptyString),
    }),
  ),
  // Set when every entry is undone.
  undoneAt: Schema.optionalKey(NonEmptyString),
  undoneBy: Schema.optionalKey(ScientSourceActor),
});
export type ScientSourcesBulkReceipt = typeof ScientSourcesBulkReceipt.Type;

export const ScientSourcesBulkResult = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      sourceId: NonEmptyString,
      outcome: Schema.Literals(["updated", "unchanged", "not-found", "failed"]),
      revision: Schema.NullOr(Schema.Int),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
  collections: Schema.Array(
    Schema.Struct({
      collectionId: NonEmptyString,
      outcome: Schema.Literals(["updated", "unchanged", "not-found", "failed"]),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
  // Present when the edit changed something; pass batchId as undoBatchId to reverse it.
  undo: Schema.optionalKey(Schema.Struct({ batchId: NonEmptyString, sourceCount: Schema.Int })),
  // Undo only: what it left as it was because of later changes.
  conflicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        sourceId: Schema.optionalKey(NonEmptyString),
        collectionId: Schema.optionalKey(NonEmptyString),
        message: Schema.String,
      }),
    ),
  ),
});
export type ScientSourcesBulkResult = typeof ScientSourcesBulkResult.Type;

export const EMPTY_SCIENT_SOURCES_ORGANIZATION: ScientSourcesOrganization = {
  collections: [],
  savedSearches: [],
};

export interface ScientSourceFilterable {
  readonly sourceId: string;
  readonly citationKey?: string | undefined;
  readonly type: ScientSourceType;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly containerTitle: string | null;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly attachments: ReadonlyArray<{ readonly kind: string }>;
  readonly externalReferences?:
    | ReadonlyArray<{
        readonly system: string;
        readonly itemKey: string;
        readonly rawItemType: string;
      }>
    | undefined;
}

export function scientSourceSearchText(source: ScientSourceFilterable): string {
  return [
    source.citationKey,
    source.title,
    source.containerTitle,
    source.issuedYear === null ? null : String(source.issuedYear),
    ...source.creators.flatMap((creator) => [
      creator.givenName,
      creator.familyName,
      creator.literalName,
    ]),
    ...source.identifiers.flatMap((identifier) => [
      identifier.scheme,
      identifier.value,
      ...(identifier.scheme.toLocaleLowerCase() === "doi"
        ? [`https://doi.org/${identifier.value}`, `https://dx.doi.org/${identifier.value}`]
        : []),
    ]),
    ...(source.externalReferences ?? []).flatMap((reference) => [
      reference.system,
      reference.itemKey,
      reference.rawItemType,
    ]),
    ...(source.tags ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}

/** Every whitespace-separated term must appear somewhere in the source's searchable text. */
function scientSourceTextMatches(searchText: string, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return terms.every((term) => searchText.includes(term));
}

export function scientSourceTagKey(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

export function scientSourceFilterIsEmpty(filter: ScientSourceFilter): boolean {
  return (
    !filter.text?.trim() &&
    (filter.tags?.length ?? 0) === 0 &&
    filter.collectionId === undefined &&
    filter.type === undefined &&
    filter.hasPdf === undefined
  );
}

export function compileScientSourceFilter(
  filter: ScientSourceFilter,
  organization: Pick<ScientSourcesOrganization, "collections">,
): (source: ScientSourceFilterable, searchText?: string) => boolean {
  const tagKeys = (filter.tags ?? []).map(scientSourceTagKey);
  const members =
    filter.collectionId === undefined
      ? null
      : new Set(
          organization.collections.find(
            (collection) => collection.collectionId === filter.collectionId,
          )?.sourceIds ?? [],
        );
  const text = filter.text?.trim() ?? "";
  return (source, searchText) => {
    if (members && !members.has(source.sourceId)) return false;
    if (filter.type !== undefined && source.type !== filter.type) return false;
    if (filter.hasPdf !== undefined) {
      const hasPdf = source.attachments.some((attachment) => attachment.kind === "pdf");
      if (hasPdf !== filter.hasPdf) return false;
    }
    if (tagKeys.length > 0) {
      const sourceTags = new Set((source.tags ?? []).map(scientSourceTagKey));
      if (!tagKeys.every((tag) => sourceTags.has(tag))) return false;
    }
    return text.length === 0
      ? true
      : scientSourceTextMatches(searchText ?? scientSourceSearchText(source), text);
  };
}

/** Tag counts across the Library, keeping the spelling seen first, most used first. */
export function scientSourceTagCounts(
  sources: ReadonlyArray<Pick<ScientSourceFilterable, "tags">>,
): ReadonlyArray<{ readonly tag: string; readonly count: number }> {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const source of sources) {
    const seen = new Set<string>();
    for (const tag of source.tags ?? []) {
      const key = scientSourceTagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag: tag.trim(), count: 1 });
    }
  }
  return [...counts.values()].toSorted(
    (left, right) =>
      right.count - left.count ||
      left.tag.localeCompare(right.tag, undefined, { sensitivity: "base" }),
  );
}

/** Adds and removes tags case-insensitively, keeping an existing tag's spelling. */
export function applyScientSourceTagChanges(input: {
  readonly tags: ReadonlyArray<string>;
  readonly add?: ReadonlyArray<string> | undefined;
  readonly remove?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const removed = new Set((input.remove ?? []).map(scientSourceTagKey));
  const next: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...input.tags, ...(input.add ?? [])]) {
    const trimmed = tag.trim();
    const key = scientSourceTagKey(trimmed);
    if (!key || seen.has(key) || removed.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}
