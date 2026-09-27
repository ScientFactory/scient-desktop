import { type ThreadSection, threadSectionCatalogsEqual } from "@t3tools/contracts";

import { readThreadSections, type SectionLayout } from "./logic";

/** The catalog as stored on the primary server. */
export type LiveLayout = {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
};

// A stale base costs a retry each; three covers a burst of concurrent edits.
const MAX_WRITE_ATTEMPTS = 3;

export type CatalogEdit<R> = (layout: LiveLayout) => {
  readonly layout: SectionLayout | null;
  readonly result: R;
};

/**
 * Applies `edit` to the stored catalog and writes the result, conditional on
 * the catalog still being the one `edit` saw. If another client wrote first,
 * the server drops the section keys and returns what it holds, and `edit`
 * runs again on that. `edit` returns a null layout to skip the write. `send`
 * resolves the catalog the server holds afterward, or null if the write failed.
 */
export async function writeCatalog<R>(input: {
  readonly stored: LiveLayout;
  readonly edit: CatalogEdit<R>;
  readonly send: (patch: {
    readonly threadSections: readonly ThreadSection[];
    readonly threadSectionsGeneralIndex: number;
    readonly threadSectionsExpected: {
      readonly threadSections: readonly ThreadSection[];
      readonly threadSectionsGeneralIndex: number;
    };
  }) => Promise<LiveLayout | null>;
}): Promise<{ ok: boolean; result: R | null }> {
  let stored = input.stored;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    // Normalized, so any write also saves older names capitalized.
    const { layout, result } = input.edit({
      sections: readThreadSections(stored.sections),
      generalIndex: stored.generalIndex,
    });
    if (layout === null) return { ok: true, result };
    const saved = await input.send({
      threadSections: layout.catalog,
      threadSectionsGeneralIndex: layout.generalIndex,
      threadSectionsExpected: {
        threadSections: stored.sections,
        threadSectionsGeneralIndex: stored.generalIndex,
      },
    });
    if (saved === null) return { ok: false, result: null };
    if (
      saved.generalIndex === layout.generalIndex &&
      threadSectionCatalogsEqual(saved.sections, layout.catalog)
    ) {
      return { ok: true, result };
    }
    stored = saved;
  }
  return { ok: false, result: null };
}
