import { companionFiles } from "./documentTemplates";

/** A file a new document created beside itself, as it was written. */
export interface CreatedCompanion {
  readonly relativePath: string;
  readonly revision: string;
}

/**
 * Brings the files a new document reads beside itself in line with its source:
 * creates each one the source names that is missing, and removes each one this
 * document created earlier that its source no longer names. A file that was
 * already there is used as it is and never removed; a removal succeeds only
 * while the file is still exactly as it was created. Returns the files the
 * document has created and still names.
 */
export async function syncCompanionFiles(input: {
  /** The document's folder: "" or "papers/". */
  readonly folder: string;
  readonly source: string;
  readonly created: readonly CreatedCompanion[];
  /** Creates an empty file; "exists" when the path is taken, null on failure. */
  readonly create: (
    relativePath: string,
  ) => Promise<{ readonly revision: string } | "exists" | null>;
  readonly remove: (file: CreatedCompanion) => Promise<boolean>;
}): Promise<readonly CreatedCompanion[]> {
  const needed = new Set(companionFiles(input.source).map((name) => `${input.folder}${name}`));
  const kept: CreatedCompanion[] = [];
  for (const file of input.created) {
    if (needed.has(file.relativePath)) kept.push(file);
    // Removed only if unchanged; a file changed since is the person's and stays.
    else await input.remove(file);
  }
  for (const relativePath of needed) {
    if (kept.some((file) => file.relativePath === relativePath)) continue;
    const result = await input.create(relativePath);
    if (result !== null && result !== "exists")
      kept.push({ relativePath, revision: result.revision });
  }
  return kept;
}
