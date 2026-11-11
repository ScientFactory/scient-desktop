import type { ScientSourceCollectionSummary } from "@scientfactory/scient-sources";

interface OrderedCollection {
  readonly collection: ScientSourceCollectionSummary;
  readonly child: boolean;
  /** "Parent / Child" for a subcollection, so two "Methods" can be told apart. */
  readonly label: string;
}

const byName = (left: ScientSourceCollectionSummary, right: ScientSourceCollectionSummary) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/** Top-level collections by name, each followed by its subcollections. */
export function orderedCollections(
  collections: ReadonlyArray<ScientSourceCollectionSummary>,
): ReadonlyArray<OrderedCollection> {
  const ids = new Set(collections.map((collection) => collection.collectionId));
  const parentOf = (collection: ScientSourceCollectionSummary) =>
    collection.parentCollectionId && ids.has(collection.parentCollectionId)
      ? collection.parentCollectionId
      : null;
  return collections
    .filter((collection) => parentOf(collection) === null)
    .toSorted(byName)
    .flatMap((parent) => [
      { collection: parent, child: false, label: parent.name },
      ...collections
        .filter((collection) => parentOf(collection) === parent.collectionId)
        .toSorted(byName)
        .map((collection) => ({
          collection,
          child: true,
          label: `${parent.name} / ${collection.name}`,
        })),
    ]);
}
