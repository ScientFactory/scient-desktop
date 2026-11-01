import type { CompanionFile } from "./documentTemplates";

/** A file a new document created beside itself, as it was written. */
export interface CreatedCompanion {
  readonly relativePath: string;
  readonly revision: string;
}

/**
 * Keep shared bibliographies and pre-existing files. Remove private companions only while their
 * bytes still match what this document created, so template changes cannot delete user edits.
 */
export async function syncCompanionFiles(input: {
  /** The document's folder: "" or "papers/". */
  readonly folder: string;
  readonly files: readonly CompanionFile[];
  readonly created: readonly CreatedCompanion[];
  /** Creates a file; "exists" when the path is taken, null on failure. */
  readonly create: (
    relativePath: string,
    contents: string,
  ) => Promise<{ readonly revision: string } | "exists" | null>;
  /** Replaces only a file still at its recorded revision. */
  readonly replace?: (
    file: CreatedCompanion,
    contents: string,
  ) => Promise<{ readonly revision: string } | null>;
  readonly remove: (file: CreatedCompanion) => Promise<boolean>;
}): Promise<{ readonly companions: readonly CreatedCompanion[]; readonly complete: boolean }> {
  const needed = new Map(input.files.map((file) => [`${input.folder}${file.name}`, file.contents]));
  const kept: CreatedCompanion[] = [];
  let complete = true;
  for (const file of input.created) {
    const contents = needed.get(file.relativePath);
    if (contents !== undefined) {
      const updated =
        !/\.bib$/iu.test(file.relativePath) && input.replace
          ? await input.replace(file, contents)
          : null;
      // A private file the person changed keeps their work, so the template is not whole.
      if (!updated && !/\.bib$/iu.test(file.relativePath) && input.replace) complete = false;
      kept.push(updated ? { ...file, revision: updated.revision } : file);
    }
    // A bibliography may already be used by another document in this folder.
    else if (!/\.bib$/iu.test(file.relativePath)) await input.remove(file);
  }
  for (const [relativePath, contents] of needed) {
    if (kept.some((file) => file.relativePath === relativePath)) continue;
    const result = await input.create(relativePath, contents);
    if (result !== null && result !== "exists")
      kept.push({ relativePath, revision: result.revision });
    // A file of the template's own that could not be written, or whose place is taken.
    else if (!/\.bib$/iu.test(relativePath)) complete = false;
  }
  return { companions: kept, complete };
}
