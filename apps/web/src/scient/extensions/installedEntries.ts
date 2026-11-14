import type { DiscoverEntry } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import { extensionsDiscoverPage } from "./extensionsState";
import { catalogEntries } from "./extensionsView";

/**
 * Curated entries to describe installed connectors with. Discover's home shows only a few per
 * category, so an installed connector outside those previews is read from the whole catalog.
 */
export function useInstalledEntries(): ReadonlyArray<DiscoverEntry> {
  const { environmentId, catalog } = useExtensionsEnvironment();
  const all = useEnvironmentQuery(
    extensionsDiscoverPage({ environmentId, input: { scope: "curated" } }),
  );
  const previews = catalogEntries(catalog);
  return [
    ...previews,
    ...(all.data?.entries ?? []).filter(
      (entry) => !previews.some((preview) => preview.name === entry.name),
    ),
  ];
}
