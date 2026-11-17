import { listScientProjectPinnedWorks } from "@scientfactory/scient-sources/project-pins";

import type { ScientSourcesLibraryStore } from "../sources/SourcesBackend.ts";

/**
 * Where a check reads sources on the library backend: the Library's records (none when this
 * computer has no Library yet), and the works this project cites, under its own keys, including
 * those it only keeps as a snapshot. Null keeps the project's own v1 store.
 */
export function referenceCheckSources(library: ScientSourcesLibraryStore | null) {
  if (!library) return {};
  const store = library.exists ? library.library : null;
  return {
    store,
    citable: async () =>
      (await listScientProjectPinnedWorks({ projectRoot: library.root, library: store })).map(
        (work) => work.record,
      ),
  };
}
