import type { ScientSourceCollectionSummary } from "@scientfactory/scient-sources";

interface OrderedCollection {
  readonly collection: ScientSourceCollectionSummary;
  /** The collections it is in, top first; none at the top level. */
  readonly aboveIds: ReadonlyArray<string>;
  readonly hasChildren: boolean;
  /** With the collection above it ("… / Methods / fMRI"), so two "fMRI" can be told apart. */
  readonly label: string;
}

const byName = (left: ScientSourceCollectionSummary, right: ScientSourceCollectionSummary) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/** The tree read top to bottom: siblings by name, each followed by what is under it. */
export function orderedCollections(
  collections: ReadonlyArray<ScientSourceCollectionSummary>,
): ReadonlyArray<OrderedCollection> {
  const ids = new Set(collections.map((collection) => collection.collectionId));
  const childrenOf = new Map<string | null, ScientSourceCollectionSummary[]>();
  for (const collection of collections) {
    const parent =
      collection.parentCollectionId && ids.has(collection.parentCollectionId)
        ? collection.parentCollectionId
        : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), collection]);
  }
  const under = (
    parentId: string | null,
    above: ReadonlyArray<ScientSourceCollectionSummary>,
  ): ReadonlyArray<OrderedCollection> =>
    (childrenOf.get(parentId) ?? []).toSorted(byName).flatMap((collection) => [
      {
        collection,
        aboveIds: above.map((entry) => entry.collectionId),
        hasChildren: childrenOf.has(collection.collectionId),
        label: [
          ...(above.length > 1 ? ["…"] : []),
          ...above.slice(-1).map((entry) => entry.name),
          collection.name,
        ].join(" / "),
      },
      ...under(collection.collectionId, [...above, collection]),
    ]);
  return under(null, []);
}

/** How far a row of the tree is set in for its level. */
export const collectionIndent = (levelsAbove: number) => ({ paddingLeft: `${levelsAbove * 12}px` });
