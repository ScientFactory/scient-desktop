import type { CompanionFile } from "./documentTemplates";

/** A file a new document created beside itself, as it was written. */
export interface CreatedCompanion {
  readonly relativePath: string;
  readonly revision: string;
}

/**
 * Brings the files a new document keeps beside itself in line with its
 * template: creates missing files, refreshes unchanged private files, and
 * removes private files this document created earlier that it no longer needs.
 * Bibliographies remain because other documents can share them. A file that was
 * already there is used as it is and never removed; a removal succeeds only
 * while the file is still exactly as it was created. Returns the files the
 * document has created and still needs.
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
}): Promise<readonly CreatedCompanion[]> {
  const needed = new Map(input.files.map((file) => [`${input.folder}${file.name}`, file.contents]));
  const kept: CreatedCompanion[] = [];
  for (const file of input.created) {
    const contents = needed.get(file.relativePath);
    if (contents !== undefined) {
      const updated =
        !/\.bib$/iu.test(file.relativePath) && input.replace
          ? await input.replace(file, contents)
          : null;
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
  }
  return kept;
}
