// @effect-diagnostics nodeBuiltinImport:off -- The managed bibliography writes plain project files beside the Promise-based Sources store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  bibtexEntriesByKey,
  compareBibliographyEntries,
  cslJsonEntriesByKey,
  renderManagedBibliography,
  type BibliographyEntryChanges,
} from "@scientfactory/scient-citations/bibliography";
import {
  assignMissingScientSourceCitationKeys,
  canonicalizeScientSourceRoot,
  listScientSourceRecords,
  onScientSourceRecordsChanged,
  SCIENT_SOURCE_RECORDS_DIRECTORY,
  SCIENT_SOURCES_DIRECTORY,
} from "@scientfactory/scient-sources/store";
import {
  assertScientProjectDirectory,
  publishScientProjectFile,
} from "@scientfactory/scient-sources/project-files";

const MANAGED_BIBLIOGRAPHY_FILES = ["references.bib", "references.json"] as const;
export type ManagedBibliographyFileName = (typeof MANAGED_BIBLIOGRAPHY_FILES)[number];

/** What Scient last wrote, so a later difference in the project file is a hand edit. */
const WRITTEN_COPY_DIRECTORY = `${SCIENT_SOURCES_DIRECTORY}/bibliography`;
const MAX_BIBLIOGRAPHY_BYTES = 8 * 1024 * 1024;

export type ManagedBibliographyFileState =
  /** Matches the Library. */
  | "current"
  /** Changed outside Scient since Scient last wrote it; kept until the user decides. */
  | "edited"
  /** A file Scient did not write is in the way; Scient never writes over it. */
  | "unmanaged"
  /** The project has no Library yet. */
  | "absent";

export interface ManagedBibliographyFileStatus {
  readonly name: ManagedBibliographyFileName;
  readonly state: ManagedBibliographyFileState;
  readonly changes: BibliographyEntryChanges | null;
}

export interface ManagedBibliographyStatus {
  readonly files: ReadonlyArray<ManagedBibliographyFileStatus>;
  readonly citedSourceCount: number;
  readonly imported?: number;
}

type FileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "file"; readonly contents: string };

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function readProjectFile(filePath: string): Promise<FileRead> {
  try {
    const stats = await NodeFSP.lstat(filePath);
    if (!stats.isFile() || stats.size > MAX_BIBLIOGRAPHY_BYTES) return { kind: "unsafe" };
    return { kind: "file", contents: await NodeFSP.readFile(filePath, "utf8") };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
}

/** The written copies live in Scient's own folder, reached only through real project folders. */
async function readWrittenCopy(root: string, name: ManagedBibliographyFileName): Promise<FileRead> {
  const directory = NodePath.join(root, WRITTEN_COPY_DIRECTORY);
  try {
    await assertScientProjectDirectory(root, directory);
  } catch (error) {
    return isNodeError(error, "ENOENT") ? { kind: "missing" } : { kind: "unsafe" };
  }
  return readProjectFile(NodePath.join(directory, name));
}

async function writeWrittenCopy(
  root: string,
  name: ManagedBibliographyFileName,
  contents: string,
): Promise<void> {
  const directory = NodePath.join(root, WRITTEN_COPY_DIRECTORY);
  await assertScientProjectDirectory(root, directory, { create: true });
  const filePath = NodePath.join(directory, name);
  const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await assertScientProjectDirectory(root, directory);
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

function entriesOf(name: ManagedBibliographyFileName, contents: string) {
  return name === "references.bib"
    ? bibtexEntriesByKey(contents)
    : (cslJsonEntriesByKey(contents) ?? new Map<string, string>());
}

async function libraryExists(root: string): Promise<boolean> {
  try {
    return (
      await NodeFSP.lstat(NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY))
    ).isDirectory();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

const lanes = new Map<string, Promise<unknown>>();
const backfilling = new Set<string>();

function inLane<A>(root: string, run: () => Promise<A>): Promise<A> {
  const previous = lanes.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  lanes.set(root, next);
  void next
    .finally(() => {
      if (lanes.get(root) === next) lanes.delete(root);
    })
    .catch(() => undefined);
  return next;
}

async function syncFile(input: {
  readonly root: string;
  readonly name: ManagedBibliographyFileName;
  readonly next: string;
  readonly hasSources: boolean;
  readonly replaceEdited: boolean;
}): Promise<ManagedBibliographyFileStatus> {
  const { name, next } = input;
  const target = NodePath.join(input.root, name);
  const [current, copy] = await Promise.all([
    readProjectFile(target),
    readWrittenCopy(input.root, name),
  ]);
  const edited = (contents: string | null): ManagedBibliographyFileStatus =>
    copy.kind === "file"
      ? {
          name,
          state: "edited",
          changes:
            contents === null
              ? null
              : compareBibliographyEntries(
                  entriesOf(name, copy.contents),
                  entriesOf(name, contents),
                ),
        }
      : { name, state: "unmanaged", changes: null };
  // Project file first: if the copy write fails, the next sync finds the file
  // already matching the Library and adopts it instead of reporting an edit.
  const publish = async (): Promise<ManagedBibliographyFileStatus> => {
    if (current.kind !== "file" || current.contents !== next) {
      const published = await publishScientProjectFile({
        filePath: target,
        expected: current.kind === "file" ? current.contents : null,
        contents: next,
      });
      if (published.outcome === "changed") {
        const now = await readProjectFile(target);
        return now.kind === "unsafe"
          ? { name, state: "unmanaged", changes: null }
          : edited(now.kind === "file" ? now.contents : null);
      }
    }
    if (copy.kind !== "file" || copy.contents !== next) {
      await writeWrittenCopy(input.root, name, next);
    }
    return { name, state: "current", changes: null };
  };

  if (current.kind === "unsafe" || copy.kind === "unsafe") {
    return { name, state: "unmanaged", changes: null };
  }
  if (current.kind === "missing") {
    return !input.hasSources && copy.kind === "missing"
      ? { name, state: "absent", changes: null }
      : publish();
  }
  if (current.contents === next) return publish();
  if (copy.kind === "missing") return { name, state: "unmanaged", changes: null };
  if (current.contents === copy.contents || input.replaceEdited) return publish();
  return edited(current.contents);
}

async function syncInLane(
  root: string,
  replaceEdited: ReadonlySet<ManagedBibliographyFileName>,
): Promise<ManagedBibliographyStatus> {
  if (!(await libraryExists(root))) {
    return {
      files: MANAGED_BIBLIOGRAPHY_FILES.map((name) => ({ name, state: "absent", changes: null })),
      citedSourceCount: 0,
    };
  }
  // This write reports a change like any other; the records are read after it.
  backfilling.add(root);
  try {
    await assignMissingScientSourceCitationKeys(root);
  } finally {
    backfilling.delete(root);
  }
  const records = await listScientSourceRecords(root);
  const rendered = renderManagedBibliography(records);
  const files: ManagedBibliographyFileStatus[] = [];
  for (const name of MANAGED_BIBLIOGRAPHY_FILES) {
    files.push(
      await syncFile({
        root,
        name,
        next: name === "references.bib" ? rendered.bibtex : rendered.cslJson,
        hasSources: records.length > 0,
        replaceEdited: replaceEdited.has(name),
      }),
    );
  }
  return { files, citedSourceCount: rendered.keys.length };
}

/**
 * Writes `references.bib` and `references.json` from the Library. A file edited
 * by hand, or one Scient did not write, is never overwritten unless the person
 * or agent names it in `replaceEdited`.
 */
export async function syncManagedBibliography(
  root: string,
  options: { readonly replaceEdited?: ReadonlyArray<ManagedBibliographyFileName> } = {},
): Promise<ManagedBibliographyStatus> {
  const canonical = await canonicalizeScientSourceRoot(root);
  return inLane(canonical, () => syncInLane(canonical, new Set(options.replaceEdited ?? [])));
}

const scheduled = new Map<string, { again: boolean }>();

/** Coalesces bursts of Library writes into at most one follow-up sync per project. */
function scheduleManagedBibliographySync(root: string): void {
  if (backfilling.has(root)) return;
  const pending = scheduled.get(root);
  if (pending) {
    pending.again = true;
    return;
  }
  const entry = { again: true };
  scheduled.set(root, entry);
  void (async () => {
    try {
      while (entry.again) {
        entry.again = false;
        await syncManagedBibliography(root).catch(() => undefined);
      }
    } finally {
      scheduled.delete(root);
    }
  })();
}

let listening = false;

/** Keeps every project's managed files current after any Library write in this server. */
export function startManagedBibliographySync(): void {
  if (listening) return;
  listening = true;
  onScientSourceRecordsChanged(scheduleManagedBibliographySync);
}
