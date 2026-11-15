// @effect-diagnostics nodeBuiltinImport:off -- The annotation store is Scient's filesystem boundary for .scient/annotations and the library's annotations, beside the Sources store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PdfMaterial } from "@scientfactory/document-artifacts";
import { readScientProjectIdentity } from "@scientfactory/project-init";
import { withScientLibraryLock } from "@scientfactory/scient-sources/library-lock";
import {
  isScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { assertScientProjectDirectory } from "@scientfactory/scient-sources/project-files";
import {
  SCIENT_ANNOTATIONS_DIRECTORY,
  ScientAnnotationActor,
  ScientAnnotationNote,
  ScientPdfAnnotation,
  ScientUnplacedAnnotation,
  type ScientAnnotationAlternative,
  type ScientAnnotationCommand,
  type ScientAnnotationMutationResult,
  type ScientPdfAnnotation as ScientPdfAnnotationType,
  type ScientUnplacedAnnotation as ScientUnplacedAnnotationType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MAX_ANNOTATIONS_PER_PDF = 5_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_PER_ANNOTATION = 10;
const MAX_SEEN_PATHS = 16;
const MAX_LISTED_FILES = 10_000;
const FILE_NAME = /^([0-9a-f]{64})\.json$/u;
const LIBRARY_ANNOTATIONS_DIRECTORY = "annotations/v1";

/**
 * Where a PDF's annotations live: a canonical project root (`.scient/annotations/v1`), or the
 * personal library with its canonical root (`annotations/v1`), for highlights on library PDFs.
 */
export type ScientAnnotationHome = ScientSourceStoreLocation;

const homeRoot = (home: ScientAnnotationHome) => (isScientLibraryLocation(home) ? home.root : home);

/** Slash-separated, inside the project: no root, drive, UNC, backslash or `..` segment. */
const ProjectPathHint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      !/[\\\0]/u.test(value) &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);

const AnnotationHistoryEntry = Schema.Struct({
  annotationId: ScientPdfAnnotation.fields.annotationId,
  revision: ScientPdfAnnotation.fields.revision,
  highlighted: Schema.Boolean,
  note: ScientAnnotationNote,
  updatedAt: ScientPdfAnnotation.fields.updatedAt,
  updatedBy: ScientAnnotationActor,
  /** Another computer's version a project package brought, kept beside this one's. */
  importedAt: Schema.optionalKey(ScientPdfAnnotation.fields.updatedAt),
});
export type AnnotationHistoryEntry = typeof AnnotationHistoryEntry.Type;

/** One file per PDF, named by the sha256 of its bytes. */
export const ScientAnnotationFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  material: Schema.Struct({
    sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  /** Project paths where these bytes were annotated, newest first. A hint, never identity. */
  paths: Schema.Array(ProjectPathHint),
  annotations: Schema.Array(ScientPdfAnnotation),
  history: Schema.Array(AnnotationHistoryEntry),
  /** Another program's highlights and comments that could not be placed on a page here. */
  unplaced: Schema.optionalKey(Schema.Array(ScientUnplacedAnnotation)),
});
export type ScientAnnotationFile = typeof ScientAnnotationFile.Type;

const decodeFile = Schema.decodeUnknownSync(ScientAnnotationFile);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function emptyFile(material: PdfMaterial): ScientAnnotationFile {
  return {
    formatVersion: 1,
    material: { sha256: material.sha256, byteLength: material.byteLength },
    paths: [],
    annotations: [],
    history: [],
  };
}

function normalizeNote(note: string): string {
  const unified = note.replaceAll("\r\n", "\n");
  return unified.trim().length === 0 ? "" : unified;
}

function sameAnchor(left: ScientPdfAnnotationType, right: ScientPdfAnnotationType["anchor"]) {
  return JSON.stringify(left.anchor) === JSON.stringify(right);
}

function historyEntry(annotation: ScientPdfAnnotationType): AnnotationHistoryEntry {
  return {
    annotationId: annotation.annotationId,
    revision: annotation.revision,
    highlighted: annotation.highlighted,
    note: annotation.note,
    updatedAt: annotation.updatedAt,
    updatedBy: annotation.updatedBy,
  };
}

function withHistory(
  history: ReadonlyArray<AnnotationHistoryEntry>,
  previous: ScientPdfAnnotationType,
): ReadonlyArray<AnnotationHistoryEntry> {
  const own = history.filter((entry) => entry.annotationId === previous.annotationId);
  const kept = own.slice(Math.max(0, own.length + 1 - MAX_HISTORY_PER_ANNOTATION));
  return [
    ...history.filter((entry) => entry.annotationId !== previous.annotationId),
    ...kept,
    historyEntry(previous),
  ];
}

export interface AnnotationCommandOutcome {
  readonly file: ScientAnnotationFile;
  readonly changed: boolean;
  readonly result: ScientAnnotationMutationResult;
}

/**
 * Applies one command to a PDF's annotations. Pure: the caller owns reading,
 * locking and writing. Edits name the revision they were made on; a stale
 * one changes nothing and returns the current annotation.
 */
export function applyAnnotationCommand(
  file: ScientAnnotationFile,
  command: ScientAnnotationCommand,
  actor: ScientAnnotationActor,
  now: string,
): AnnotationCommandOutcome {
  const unchanged = (
    outcome: ScientAnnotationMutationResult["outcome"],
    annotation: ScientPdfAnnotationType | null,
  ): AnnotationCommandOutcome => ({ file, changed: false, result: { outcome, annotation } });
  const index = file.annotations.findIndex(
    (annotation) => annotation.annotationId === command.annotationId,
  );
  const current = index === -1 ? null : file.annotations[index]!;
  const replace = (
    next: ScientPdfAnnotationType,
    outcome: ScientAnnotationMutationResult["outcome"],
  ): AnnotationCommandOutcome => ({
    file: {
      ...file,
      annotations: file.annotations.map((annotation, at) => (at === index ? next : annotation)),
      history: withHistory(file.history, current!),
    },
    changed: true,
    result: { outcome, annotation: next },
  });

  if (command.action === "create") {
    if (current) {
      return unchanged(sameAnchor(current, command.anchor) ? "unchanged" : "stale", current);
    }
    const note = normalizeNote(command.note);
    if (!command.highlighted && note.length === 0) return unchanged("empty", null);
    const live = file.annotations.filter((annotation) => annotation.deletedAt === null).length;
    if (live >= MAX_ANNOTATIONS_PER_PDF) return unchanged("limit-reached", null);
    const created: ScientPdfAnnotationType = {
      annotationId: command.annotationId,
      revision: 1,
      anchor: command.anchor,
      highlighted: command.highlighted,
      note,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
      deletedAt: null,
    };
    return {
      file: { ...file, annotations: [...file.annotations, created] },
      changed: true,
      result: { outcome: "created", annotation: created },
    };
  }

  if (!current) {
    return command.action === "remove" || command.action === "restore"
      ? applyUnplacedCommand(file, command, now)
      : unchanged("not-found", null);
  }
  if (command.expectedRevision !== current.revision) return unchanged("stale", current);
  const revised = { revision: current.revision + 1, updatedAt: now, updatedBy: actor };

  switch (command.action) {
    case "remove":
      if (current.deletedAt !== null) return unchanged("unchanged", current);
      return replace({ ...current, ...revised, deletedAt: now }, "removed");
    case "restore":
      if (current.deletedAt === null) return unchanged("unchanged", current);
      return replace({ ...current, ...revised, deletedAt: null }, "restored");
    case "update":
    case "revert": {
      if (current.deletedAt !== null) return unchanged("not-found", null);
      let target: { readonly highlighted: boolean; readonly note: string };
      if (command.action === "update") {
        target = {
          highlighted: command.highlighted ?? current.highlighted,
          note: command.note === undefined ? current.note : normalizeNote(command.note),
        };
      } else {
        const earlier = file.history.find(
          (entry) =>
            entry.annotationId === current.annotationId &&
            entry.revision === command.toRevision &&
            (command.toNote === undefined || entry.note === command.toNote) &&
            (command.toHighlighted === undefined || entry.highlighted === command.toHighlighted),
        );
        if (!earlier) return unchanged("not-found", null);
        target = { highlighted: earlier.highlighted, note: earlier.note };
      }
      if (!target.highlighted && target.note.length === 0) return unchanged("empty", current);
      if (target.highlighted === current.highlighted && target.note === current.note) {
        return unchanged("unchanged", current);
      }
      return replace({ ...current, ...revised, ...target }, "updated");
    }
  }
}

/** Removes or brings back one that is not placed on the page; it has no other change. */
function applyUnplacedCommand(
  file: ScientAnnotationFile,
  command: Extract<ScientAnnotationCommand, { readonly action: "remove" | "restore" }>,
  now: string,
): AnnotationCommandOutcome {
  const entry = file.unplaced?.find((candidate) => candidate.annotationId === command.annotationId);
  const unchanged = (outcome: ScientAnnotationMutationResult["outcome"]) => ({
    file,
    changed: false,
    result: { outcome, annotation: null, ...(entry ? { unplaced: entry } : {}) },
  });
  if (!entry) return unchanged("not-found");
  if (command.expectedRevision !== entry.revision) return unchanged("stale");
  const removing = command.action === "remove";
  if ((entry.deletedAt !== null) === removing) return unchanged("unchanged");
  const next = { ...entry, revision: entry.revision + 1, deletedAt: removing ? now : null };
  return {
    file: {
      ...file,
      unplaced: (file.unplaced ?? []).map((candidate) => (candidate === entry ? next : candidate)),
    },
    changed: true,
    result: { outcome: removing ? "removed" : "restored", annotation: null, unplaced: next },
  };
}

/** A highlight another program held, already placed on this PDF's text. */
export interface ImportedAnnotation {
  readonly annotationId: string;
  readonly anchor: ScientPdfAnnotationType["anchor"];
  readonly note: string;
  readonly color?: string;
  readonly underline?: true;
  /** When the person made it there. */
  readonly at: string;
}

/**
 * Adds another program's highlights to a PDF's file, each once: an ID the file already has,
 * placed or not, live or removed, is left as it is, so one removed here never comes back.
 * Pure; `added` is how many of each kind are new.
 */
function addImportedAnnotations(
  file: ScientAnnotationFile,
  placed: ReadonlyArray<ImportedAnnotation>,
  unplaced: ReadonlyArray<ScientUnplacedAnnotationType>,
): {
  readonly file: ScientAnnotationFile;
  readonly added: { readonly placed: number; readonly unplaced: number };
} {
  const known = new Set(
    [...file.annotations, ...(file.unplaced ?? [])].map((entry) => entry.annotationId),
  );
  const fresh = <A extends { readonly annotationId: string }>(entries: ReadonlyArray<A>) =>
    entries.filter((entry) => !known.has(entry.annotationId) && known.add(entry.annotationId));
  const newPlaced = fresh(placed);
  const newUnplaced = fresh(unplaced);
  if (newPlaced.length === 0 && newUnplaced.length === 0) {
    return { file, added: { placed: 0, unplaced: 0 } };
  }
  return {
    file: {
      ...file,
      annotations: [
        ...file.annotations,
        ...newPlaced.map((entry): ScientPdfAnnotationType => ({
          annotationId: entry.annotationId,
          revision: 1,
          anchor: entry.anchor,
          highlighted: true,
          note: normalizeNote(entry.note),
          ...(entry.color ? { color: entry.color } : {}),
          ...(entry.underline ? { underline: true } : {}),
          createdAt: entry.at,
          createdBy: "user",
          updatedAt: entry.at,
          updatedBy: "user",
          deletedAt: null,
        })),
      ],
      ...(newUnplaced.length > 0 ? { unplaced: [...(file.unplaced ?? []), ...newUnplaced] } : {}),
    },
    added: { placed: newPlaced.length, unplaced: newUnplaced.length },
  };
}

function rememberAnnotationPath(
  file: ScientAnnotationFile,
  relativePath: string | null,
): ScientAnnotationFile {
  if (relativePath === null || file.paths[0] === relativePath) return file;
  return {
    ...file,
    paths: [relativePath, ...file.paths.filter((path) => path !== relativePath)].slice(
      0,
      MAX_SEEN_PATHS,
    ),
  };
}

export function annotationHistory(
  file: ScientAnnotationFile,
  annotationId: string,
): ReadonlyArray<AnnotationHistoryEntry> {
  return file.history.filter((entry) => entry.annotationId === annotationId);
}

/** The project root, canonical, once it is an initialized Scient project. */
export async function annotationProjectRoot(root: string): Promise<string> {
  const canonical = await NodeFSP.realpath(root);
  await readScientProjectIdentity(canonical);
  return canonical;
}

function annotationsDirectory(home: ScientAnnotationHome): string {
  const relative = isScientLibraryLocation(home)
    ? LIBRARY_ANNOTATIONS_DIRECTORY
    : SCIENT_ANNOTATIONS_DIRECTORY;
  return NodePath.join(homeRoot(home), ...relative.split("/"));
}

function annotationFilePath(root: ScientAnnotationHome, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("The PDF hash is not a sha256 digest.");
  return NodePath.join(annotationsDirectory(root), `${sha256}.json`);
}

/** Reads the file named for `sha256`; a file whose recorded identity differs is refused, never used. */
async function readFileAt(
  home: ScientAnnotationHome,
  sha256: string,
  byteLength?: number,
): Promise<ScientAnnotationFile | null> {
  const filePath = annotationFilePath(home, sha256);
  let stats;
  try {
    await assertScientProjectDirectory(homeRoot(home), NodePath.dirname(filePath));
    stats = await NodeFSP.lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
  }
  const value: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
  const file = decodeFile(value);
  if (file.material.sha256 !== sha256) {
    throw new Error(`${NodePath.basename(filePath)} records another PDF.`);
  }
  if (byteLength !== undefined && file.material.byteLength !== byteLength) {
    throw new Error("The annotation file belongs to a PDF of a different size.");
  }
  return file;
}

async function writeFileAt(home: ScientAnnotationHome, file: ScientAnnotationFile): Promise<void> {
  const filePath = annotationFilePath(home, file.material.sha256);
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
    throw new Error("The PDF has too many annotations to save.");
  }
  await assertScientProjectDirectory(homeRoot(home), NodePath.dirname(filePath), { create: true });
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await NodeFSP.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}

const locks = new Map<string, Promise<unknown>>();

async function withLock<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  locks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Reads one PDF's annotations; a missing file is none. A damaged file throws, never reads as empty. */
export async function readScientAnnotationFile(
  home: ScientAnnotationHome,
  sha256: string,
): Promise<ScientAnnotationFile | null> {
  return readFileAt(home, sha256);
}

/** Writes another program's highlights for one PDF, under the same locks as every change. */
export async function importScientAnnotations(input: {
  readonly canonicalRoot: ScientAnnotationHome;
  readonly material: PdfMaterial;
  readonly placed: ReadonlyArray<ImportedAnnotation>;
  readonly unplaced: ReadonlyArray<ScientUnplacedAnnotationType>;
}): Promise<{ readonly placed: number; readonly unplaced: number }> {
  const home = input.canonicalRoot;
  const write = () =>
    withLock(annotationFilePath(home, input.material.sha256), async () => {
      const existing = await readFileAt(home, input.material.sha256, input.material.byteLength);
      const outcome = addImportedAnnotations(
        existing ?? emptyFile(input.material),
        input.placed,
        input.unplaced,
      );
      if (outcome.added.placed + outcome.added.unplaced > 0) await writeFileAt(home, outcome.file);
      return outcome.added;
    });
  return isScientLibraryLocation(home) ? withScientLibraryLock(home.root, write) : write();
}

/** In the library, a write holds the library lock like every other library writer. */
export async function mutateScientAnnotations(input: {
  /** The canonical project root, or the library for a library PDF. */
  readonly canonicalRoot: ScientAnnotationHome;
  readonly material: PdfMaterial;
  readonly relativePath: string | null;
  readonly command: ScientAnnotationCommand;
  readonly actor: ScientAnnotationActor;
  readonly now: string;
}): Promise<ScientAnnotationMutationResult> {
  const filePath = annotationFilePath(input.canonicalRoot, input.material.sha256);
  const home = input.canonicalRoot;
  const locked = (run: () => Promise<ScientAnnotationMutationResult>) =>
    isScientLibraryLocation(home) ? withScientLibraryLock(home.root, run) : run();
  return locked(() =>
    withLock(filePath, async () => {
      const existing = await readFileAt(
        input.canonicalRoot,
        input.material.sha256,
        input.material.byteLength,
      );
      const outcome = applyAnnotationCommand(
        existing ?? emptyFile(input.material),
        input.command,
        input.actor,
        input.now,
      );
      if (outcome.changed) {
        await writeFileAt(
          input.canonicalRoot,
          rememberAnnotationPath(outcome.file, input.relativePath),
        );
      }
      return outcome.result;
    }),
  );
}

export interface ScientAnnotationFileListing {
  readonly files: ReadonlyArray<ScientAnnotationFile>;
  /** Files that could not be read, by name, so one bad file never hides the rest. */
  readonly unreadable: ReadonlyArray<string>;
}

/** Every annotation file at `home`, or only those for `only` (PDF hashes). */
export async function listScientAnnotationFiles(
  home: ScientAnnotationHome,
  only?: ReadonlySet<string>,
): Promise<ScientAnnotationFileListing> {
  const directory = annotationsDirectory(home);
  let names: string[];
  try {
    await assertScientProjectDirectory(homeRoot(home), directory);
    names = await NodeFSP.readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { files: [], unreadable: [] };
    throw error;
  }
  const files: ScientAnnotationFile[] = [];
  const unreadable: string[] = [];
  const wanted = only ? names.filter((name) => only.has(FILE_NAME.exec(name)?.[1] ?? "")) : names;
  for (const name of wanted.toSorted().slice(0, MAX_LISTED_FILES)) {
    const match = FILE_NAME.exec(name);
    if (!match) continue;
    try {
      const file = await readFileAt(home, match[1]!);
      if (file) files.push(file);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { files, unreadable };
}

/** Versions a package brought of live annotations that differ from what they show now. */
export function scientAnnotationAlternatives(
  file: ScientAnnotationFile,
): ReadonlyArray<ScientAnnotationAlternative> {
  const live = new Map(
    file.annotations
      .filter((annotation) => annotation.deletedAt === null)
      .map((annotation) => [annotation.annotationId, annotation] as const),
  );
  return file.history.flatMap((entry) => {
    const current = live.get(entry.annotationId);
    if (entry.importedAt === undefined || !current) return [];
    if (current.note === entry.note && current.highlighted === entry.highlighted) return [];
    return [
      {
        annotationId: entry.annotationId,
        revision: entry.revision,
        highlighted: entry.highlighted,
        note: entry.note,
        updatedAt: entry.updatedAt,
        importedAt: entry.importedAt,
      },
    ];
  });
}
