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
  /**
   * The edit skipped the write because a section it needs is not in `layout`.
   * The local copy can trail this client's own writes (the server's settings
   * stream lands after the write resolves), so a skip is only trusted once the
   * server confirms `layout` is current; otherwise `edit` reruns on its copy.
   */
  readonly needsCurrentLayout?: boolean;
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
  let confirmed = false;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    // Normalized, so any write also saves older names capitalized.
    const { layout, result, needsCurrentLayout } = input.edit({
      sections: readThreadSections(stored.sections),
      generalIndex: stored.generalIndex,
    });
    if (layout === null && (needsCurrentLayout !== true || confirmed)) {
      return { ok: true, result };
    }
    // A skipped edit confirms its copy with a write that changes nothing:
    // the server applies it only if its catalog is exactly `stored`.
    const written = layout ?? { catalog: [...stored.sections], generalIndex: stored.generalIndex };
    const saved = await input.send({
      threadSections: written.catalog,
      threadSectionsGeneralIndex: written.generalIndex,
      threadSectionsExpected: {
        threadSections: stored.sections,
        threadSectionsGeneralIndex: stored.generalIndex,
      },
    });
    if (saved === null) return { ok: false, result: null };
    if (
      saved.generalIndex === written.generalIndex &&
      threadSectionCatalogsEqual(saved.sections, written.catalog)
    ) {
      if (layout !== null) return { ok: true, result };
      confirmed = true;
    }
    stored = saved;
  }
  return { ok: false, result: null };
}
