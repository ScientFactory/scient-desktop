import {
  FOLDER_DOCUMENT_MAIN,
  type DocumentTemplateId,
  type NewDocumentFormat,
  isFolderTemplate,
  newDocumentCandidate,
  newDocumentStem,
  templateCompanions,
  templateName,
} from "./documentTemplates";
import { type CreatedCompanion, syncCompanionFiles } from "./newDocumentCompanions";

/** The project-file commands placing a new document needs, for one project. */
export interface NewDocumentFileCommands {
  /** Creates a file; "exists" when the path is taken, null on failure. */
  readonly create: (
    relativePath: string,
    contents: string,
  ) => Promise<{ readonly revision: string } | "exists" | null>;
  readonly replace?: (
    file: CreatedCompanion,
    contents: string,
  ) => Promise<{ readonly revision: string } | null>;
  readonly remove: (
    file: CreatedCompanion,
    options?: { readonly removeEmptyFolders?: boolean },
  ) => Promise<boolean>;
  /** What a folder ("" for the project root) holds, or null if it cannot be read. */
  readonly list: (relativeDirectory: string) => Promise<readonly FolderEntry[] | null>;
}

export interface FolderEntry {
  readonly name: string;
  readonly folder: boolean;
}

export interface PlacedNewDocument {
  readonly relativePath: string;
  readonly revision: string;
  readonly companions: readonly CreatedCompanion[];
}

const ATTEMPTS = 50;

function isTaken(entries: readonly FolderEntry[], name: string): boolean {
  return entries.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}

/** A folder name in `base` nothing uses yet: `stem`, then `stem-2` and on. */
export async function freeFolderName(
  commands: NewDocumentFileCommands,
  base: string,
  stem: string,
): Promise<string | null> {
  const taken = await commands.list(base);
  if (taken === null) return null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const name = attempt <= 1 ? stem : `${stem}-${attempt}`;
    if (!isTaken(taken, name)) return name;
  }
  return null;
}

/** Every file under a folder, as project paths; null if any part cannot be read. */
export async function filesUnder(
  commands: NewDocumentFileCommands,
  folder: string,
): Promise<readonly string[] | null> {
  const entries = await commands.list(folder);
  if (entries === null) return null;
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.folder) {
      files.push(`${folder}${entry.name}`);
      continue;
    }
    const inner = await filesUnder(commands, `${folder}${entry.name}/`);
    if (inner === null) return null;
    files.push(...inner);
  }
  return files;
}

/** The folder a path is in: "" or "papers/". */
export function folderOf(relativePath: string): string {
  return relativePath.slice(0, relativePath.lastIndexOf("/") + 1);
}

/**
 * Where a new document sits in the project: its own folder, or for a template
 * that is a folder, the folder that one is in.
 */
export function newDocumentBase(relativePath: string, template: DocumentTemplateId): string {
  const folder = folderOf(relativePath);
  return isFolderTemplate(template) ? folderOf(folder.slice(0, -1)) : folder;
}

/** The name a new document has until it takes its title's. */
export function untitledStem(format: NewDocumentFormat, template: DocumentTemplateId): string {
  return format === "latex" && isFolderTemplate(template)
    ? newDocumentStem(templateName(template))
    : "untitled";
}

/**
 * Creates a new document in `base`: `<stem>.tex` or `.md`, or for a LaTeX
 * template that is a folder, `<stem>/main.tex` in a folder nothing in the
 * project uses yet; then the files it keeps beside it. Further attempts number
 * the name. A path `skip` rejects is passed over. Null if nothing could be
 * created.
 */
export async function placeNewDocument(input: {
  readonly format: NewDocumentFormat;
  readonly base: string;
  readonly stem: string;
  readonly template: DocumentTemplateId;
  readonly source: string;
  readonly commands: NewDocumentFileCommands;
  readonly skip?: (relativePath: string) => boolean;
}): Promise<PlacedNewDocument | null> {
  const latex = input.format === "latex";
  const folder = latex && isFolderTemplate(input.template);
  const taken = folder ? await input.commands.list(input.base) : [];
  if (taken === null) return null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const name = attempt <= 1 ? input.stem : `${input.stem}-${attempt}`;
    if (folder && isTaken(taken, name)) continue;
    const relativePath = folder
      ? `${input.base}${name}/${FOLDER_DOCUMENT_MAIN}`
      : newDocumentCandidate(input.stem, input.format, attempt, input.base);
    if (input.skip?.(relativePath)) continue;
    const created = await input.commands.create(relativePath, input.source);
    if (created === "exists") continue;
    if (created === null) return null;
    const companions = latex
      ? await syncCompanionFiles({
          folder: folderOf(relativePath),
          files: templateCompanions(input.template, input.source),
          created: [],
          create: input.commands.create,
          remove: input.commands.remove,
        })
      : [];
    return { relativePath, revision: created.revision, companions };
  }
  return null;
}
