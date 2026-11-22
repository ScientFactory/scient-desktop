import {
  type DiscoverCatalog,
  type DiscoverEntry,
  type DiscoverPage,
  EXTENSION_CATEGORIES_BEFORE_KNOWN_CATEGORIES,
  type ExtensionCategory,
} from "@t3tools/contracts";

/** Where a category's entries were listed before it existed. */
const EARLIER_CATEGORIES: Partial<Record<ExtensionCategory, ReadonlyArray<ExtensionCategory>>> = {
  "ai-ml": ["code", "data"],
  cloud: ["code"],
};

/** The categories a request's client decodes. A request without the field predates it. */
export const requestKnownCategories = (
  knownCategories: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => knownCategories ?? EXTENSION_CATEGORIES_BEFORE_KNOWN_CATEGORIES;

/**
 * The categories a client lists an entry under: each one it cannot decode becomes those its
 * entries had before it existed. Browsing filters by these too, so a category page lists exactly
 * the entries that name it. Without `knownCategories` (in-process callers) nothing changes.
 */
export const categoriesForClient = (knownCategories: ReadonlyArray<string> | undefined) => {
  if (knownCategories === undefined)
    return (categories: ReadonlyArray<ExtensionCategory>) => categories;
  const known = new Set(knownCategories);
  return (categories: ReadonlyArray<ExtensionCategory>): ReadonlyArray<ExtensionCategory> =>
    categories.every((category) => known.has(category))
      ? categories
      : [
          ...new Set(
            categories.flatMap((category) =>
              known.has(category)
                ? [category]
                : (EARLIER_CATEGORIES[category] ?? []).filter((earlier) => known.has(earlier)),
            ),
          ),
        ];
};

/**
 * Discover results naming only the categories a client can decode, so an older client never
 * meets a category its schema rejects.
 */
export const forClientCategories = (knownCategories: ReadonlyArray<string>) => {
  const known = new Set(knownCategories);
  const shown = categoriesForClient(knownCategories);
  const entry = <E extends DiscoverEntry>(value: E): E => {
    const categories = shown(value.categories);
    return categories === value.categories ? value : { ...value, categories };
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
