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
  type ScientAnnotationCommand,
  type ScientAnnotationMutationResult,
  type ScientPdfAnnotation as ScientPdfAnnotationType,
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

  if (!current) return unchanged("not-found", null);
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
            entry.annotationId === current.annotationId && entry.revision === command.toRevision,
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
