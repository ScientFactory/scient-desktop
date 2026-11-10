// @effect-diagnostics nodeBuiltinImport:off -- The annotation store is Scient's project filesystem boundary for .scient/annotations, beside the Sources store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { PdfMaterial } from "@scientfactory/document-artifacts";
import { readScientProjectIdentity } from "@scientfactory/project-init";
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
  paths: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
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

function annotationsDirectory(root: string): string {
  return NodePath.join(root, ...SCIENT_ANNOTATIONS_DIRECTORY.split("/"));
}

function annotationFilePath(root: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("The PDF hash is not a sha256 digest.");
  return NodePath.join(annotationsDirectory(root), `${sha256}.json`);
}

async function ensureDirectory(directory: string): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true });
  const stats = await NodeFSP.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The annotation folder is not a safe directory.");
  }
}

async function readFileAt(filePath: string): Promise<ScientAnnotationFile | null> {
  let stats;
  try {
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
  return decodeFile(value);
}

async function writeFileAt(filePath: string, file: ScientAnnotationFile): Promise<void> {
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
    throw new Error("The PDF has too many annotations to save.");
  }
  await ensureDirectory(NodePath.dirname(filePath));
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
  canonicalRoot: string,
  sha256: string,
): Promise<ScientAnnotationFile | null> {
  return readFileAt(annotationFilePath(canonicalRoot, sha256));
}

export async function mutateScientAnnotations(input: {
  readonly canonicalRoot: string;
  readonly material: PdfMaterial;
  readonly relativePath: string | null;
  readonly command: ScientAnnotationCommand;
  readonly actor: ScientAnnotationActor;
  readonly now: string;
}): Promise<ScientAnnotationMutationResult> {
  const filePath = annotationFilePath(input.canonicalRoot, input.material.sha256);
  return withLock(filePath, async () => {
    const existing = await readFileAt(filePath);
    if (existing && existing.material.byteLength !== input.material.byteLength) {
      throw new Error("The annotation file belongs to a PDF of a different size.");
    }
    const outcome = applyAnnotationCommand(
      existing ?? emptyFile(input.material),
      input.command,
      input.actor,
      input.now,
    );
    if (outcome.changed) {
      await writeFileAt(filePath, rememberAnnotationPath(outcome.file, input.relativePath));
    }
    return outcome.result;
  });
}

export interface ScientAnnotationFileListing {
  readonly files: ReadonlyArray<ScientAnnotationFile>;
  /** Files that could not be read, by name, so one bad file never hides the rest. */
  readonly unreadable: ReadonlyArray<string>;
}

export async function listScientAnnotationFiles(
  canonicalRoot: string,
): Promise<ScientAnnotationFileListing> {
  const directory = annotationsDirectory(canonicalRoot);
  let names: string[];
  try {
    names = await NodeFSP.readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { files: [], unreadable: [] };
    throw error;
  }
  const files: ScientAnnotationFile[] = [];
  const unreadable: string[] = [];
  for (const name of names.toSorted().slice(0, MAX_LISTED_FILES)) {
    const match = FILE_NAME.exec(name);
    if (!match) continue;
    try {
      const file = await readFileAt(NodePath.join(directory, name));
      if (file && file.material.sha256 === match[1]) files.push(file);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { files, unreadable };
}
