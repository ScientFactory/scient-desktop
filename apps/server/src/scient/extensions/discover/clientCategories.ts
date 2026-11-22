import type {
  DiscoverCatalog,
  DiscoverEntry,
  DiscoverPage,
  ExtensionCategory,
} from "@t3tools/contracts";

/** What clients from before `knownCategories` decode. Never extend it. */
const CATEGORIES_BEFORE_KNOWN_CATEGORIES: ReadonlySet<string> = new Set<ExtensionCategory>([
  "most-used",
  "papers",
  "biology",
  "code",
  "data",
  "physics-math",
  "files",
  "communication",
  "projects",
  "figures",
  "chemistry",
  "earth",
  "social-science",
]);

/** Where a category's entries were listed before it existed. */
const EARLIER_CATEGORIES: Partial<Record<ExtensionCategory, ReadonlyArray<ExtensionCategory>>> = {
  "ai-ml": ["code", "data"],
  cloud: ["code"],
};

/**
 * Discover results naming only the categories a client can decode, so an older client never
 * meets a category its schema rejects. Without `knownCategories` the client predates the field.
 */
export const forClientCategories = (knownCategories: ReadonlyArray<string> | undefined) => {
  const known =
    knownCategories === undefined ? CATEGORIES_BEFORE_KNOWN_CATEGORIES : new Set(knownCategories);
  const entry = <E extends DiscoverEntry>(value: E): E =>
    value.categories.every((category) => known.has(category))
      ? value
      : {
          ...value,
          categories: [
            ...new Set(
              value.categories.flatMap((category) =>
                known.has(category)
                  ? [category]
                  : (EARLIER_CATEGORIES[category] ?? []).filter((earlier) => known.has(earlier)),
              ),
            ),
          ],
        };
  return {
    entry,
    page: (page: DiscoverPage): DiscoverPage => ({ ...page, entries: page.entries.map(entry) }),
    catalog: (catalog: DiscoverCatalog): DiscoverCatalog => ({
      ...catalog,
      sections: catalog.sections
        .filter((section) => known.has(section.category))
        .map((section) => ({ ...section, entries: section.entries.map(entry) })),
    }),
  };
};
