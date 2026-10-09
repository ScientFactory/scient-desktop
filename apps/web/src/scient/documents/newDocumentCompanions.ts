import type { CompanionFile } from "./documentTemplates";

/** A file a new document created beside itself, as it was written. */
export interface CreatedCompanion {
  readonly relativePath: string;
  readonly revision: string;
}

/**
 * Brings the files a new document keeps beside itself in line with its
 * template: creates each one it needs that is missing, and removes each one
 * this document created earlier that it no longer needs. A file that was
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
  readonly remove: (file: CreatedCompanion) => Promise<boolean>;
}): Promise<readonly CreatedCompanion[]> {
  const needed = new Map(input.files.map((file) => [`${input.folder}${file.name}`, file.contents]));
  const kept: CreatedCompanion[] = [];
  for (const file of input.created) {
    if (needed.has(file.relativePath)) kept.push(file);
    // Removed only if unchanged; a file changed since is the person's and stays.
    else await input.remove(file);
  }
  for (const [relativePath, contents] of needed) {
    if (kept.some((file) => file.relativePath === relativePath)) continue;
    const result = await input.create(relativePath, contents);
    if (result !== null && result !== "exists")
      kept.push({ relativePath, revision: result.revision });
  }
  return kept;
}
