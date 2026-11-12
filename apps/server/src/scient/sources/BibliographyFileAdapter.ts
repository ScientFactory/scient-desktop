// @effect-diagnostics nodeBuiltinImport:off -- This owned Promise-based Sources adapter reads bounded reference files from the project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  bibliographyExportItems,
  detectBibliographyFormat,
  exportBibliographyFile,
  parseBibliography,
  planBibliographyImport,
  BIBLIOGRAPHY_FILE_EXTENSIONS,
  BIBLIOGRAPHY_FILE_MAX_BYTES,
  type BibliographyFormat,
  type BibliographyImportReport,
} from "@scientfactory/scient-sources/bibliography";
import {
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  type ScientSourceActor,
  type ScientSourceCandidate,
  type ScientSourceImportOperation,
  type ScientSourceVerification,
} from "@scientfactory/scient-sources";
import {
  canonicalizeScientSourceRoot,
  createSourceImportOperation,
  listScientSourceRecords,
  readScientSourceStagedFileImport,
  readSourceImportOperation,
  removeScientSourceStagedFileImport,
  scientSourceIdFor,
  writeScientSourceStagedFileImport,
} from "@scientfactory/scient-sources/store";
import { resolveScientProjectFile } from "@scientfactory/scient-sources/project-files";

export interface BibliographyFileImportResult {
  readonly operation: ScientSourceImportOperation | null;
  readonly report: BibliographyImportReport;
}

/** Adapter errors are written for people; filesystem errors can carry host paths and are replaced. */
export function bibliographyFileErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "The file was not found in this project.";
  if (code !== undefined) return fallback;
  return error.message;
}

const FORMAT_HELP = "Use a BibTeX (.bib), RIS (.ris), CSL-JSON (.json) or EndNote XML (.xml) file.";

function fileImportSourceKey(identity: string): string {
  return `file_${NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > BIBLIOGRAPHY_FILE_MAX_BYTES) {
    throw new Error("This reference file is larger than 32 MB. Split it and import the parts.");
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Older EndNote and Windows exports are often Windows-1252, not UTF-8.
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(bytes) : utf8;
}

export async function readBibliographyFile(filePath: string): Promise<string> {
  const stats = await NodeFSP.stat(filePath);
  if (stats.size > BIBLIOGRAPHY_FILE_MAX_BYTES) {
    throw new Error("This reference file is larger than 32 MB. Split it and import the parts.");
  }
  return decodeText(await NodeFSP.readFile(filePath));
}

const REFERENCE_FILE_EXTENSIONS = [".bib", ".bibtex", ".biblatex", ".ris", ".json", ".xml", ".txt"];

/** A project reference file; Library storage and the rest of `.scient` are refused. */
export async function resolveProjectBibliographyFile(root: string, relativePath: string) {
  return resolveScientProjectFile(root, relativePath, {
    extensions: REFERENCE_FILE_EXTENSIONS,
    description: "reference file",
  });
}

async function plan(
  root: string,
  input: { readonly fileName: string; readonly text: string; readonly format?: BibliographyFormat },
) {
  const format = input.format ?? detectBibliographyFormat(input.fileName, input.text);
  if (!format) {
    throw new Error(`Scient could not tell what kind of reference file this is. ${FORMAT_HELP}`);
  }
  const existing = await listScientSourceRecords(root);
  // Every listed record belongs to this project, so any one carries its ID.
  const projectId = existing[0]?.projectId;
  return planBibliographyImport({
    parse: parseBibliography(input.text, format),
    existing,
    sourceKeyFor: fileImportSourceKey,
    sourceIdFor: (sourceKey) => (projectId ? scientSourceIdFor(projectId, sourceKey) : sourceKey),
    limit: SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  });
}

/**
 * Reads a reference file into candidates, stages the next batch of new ones
 * and starts the ordinary durable import operation for them. Replaying the
 * same operation ID returns that operation.
 */
export async function beginBibliographyFileImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly fileName: string;
  readonly text: string;
  readonly format?: BibliographyFormat;
  readonly actor: ScientSourceActor;
}): Promise<BibliographyFileImportResult> {
  const root = await canonicalizeScientSourceRoot(input.root);
  const existingOperation = await readSourceImportOperation(root, input.operationId);
  if (existingOperation) {
    if (existingOperation.adapter !== "file") {
      throw new Error("This operation ID already belongs to another import.");
    }
    const staged = await readScientSourceStagedFileImport(root, input.operationId);
    return {
      operation: existingOperation,
      report: staged?.report ?? (await plan(root, input)).report,
    };
  }
  const { candidates, report } = await plan(root, input);
  if (candidates.length === 0) return { operation: null, report };
  await writeScientSourceStagedFileImport(root, {
    formatVersion: 1,
    operationId: input.operationId,
    fileName: NodePath.basename(input.fileName),
    report,
    candidates: [...candidates],
  });
  try {
    const operation = await createSourceImportOperation({
      root,
      operationId: input.operationId,
      adapter: "file",
      intake: "file",
      actor: input.actor,
      itemKeys: candidates.map((candidate) => candidate.sourceKey),
    });
    return { operation, report };
  } catch (error) {
    await removeScientSourceStagedFileImport(root, input.operationId);
    throw error;
  }
}

let cachedStage: {
  readonly key: string;
  readonly candidates: ReadonlyMap<string, ScientSourceCandidate>;
} | null = null;

/** The staged candidate for one operation item; the parsed stage is reused across items. */
export async function getBibliographyFileImportCandidate(
  root: string,
  operationId: string,
  itemKey: string,
): Promise<ScientSourceCandidate> {
  const key = `${root}\0${operationId}`;
  if (cachedStage?.key !== key) {
    const staged = await readScientSourceStagedFileImport(root, operationId);
    if (!staged) throw new Error("The reference file for this import is no longer staged.");
    cachedStage = {
      key,
      candidates: new Map(staged.candidates.map((candidate) => [candidate.sourceKey, candidate])),
    };
  }
  const candidate = cachedStage.candidates.get(itemKey);
  if (!candidate) throw new Error("This entry is not part of the staged reference file.");
  return candidate;
}

export async function discardBibliographyFileImport(root: string, operationId: string) {
  if (cachedStage?.key === `${root}\0${operationId}`) cachedStage = null;
  await removeScientSourceStagedFileImport(root, operationId);
}

const VERIFYING_SCHEMES = ["doi", "pmid"] as const;

/** A file's identifiers are recorded as given; the Library has not checked them yet. */
export function fileImportVerification(candidate: ScientSourceCandidate): ScientSourceVerification {
  for (const scheme of VERIFYING_SCHEMES) {
    const identifier = candidate.identifiers.find((entry) => entry.scheme === scheme);
    if (identifier) return { state: "unchecked", identifier };
  }
  return { state: "unverified" };
}

export async function exportBibliography(input: {
  readonly root: string;
  readonly format: BibliographyFormat;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly includeNotes?: boolean;
}) {
  const records = await listScientSourceRecords(input.root);
  const wanted = input.sourceIds ? new Set(input.sourceIds) : null;
  const selected = wanted ? records.filter((record) => wanted.has(record.sourceId)) : records;
  const missing = wanted
    ? [...wanted].filter((sourceId) => !selected.some((record) => record.sourceId === sourceId))
    : [];
  const ordered = selected.toSorted((left, right) =>
    (left.citationKey ?? left.sourceId).localeCompare(right.citationKey ?? right.sourceId),
  );
  const { content, notKept } = exportBibliographyFile(
    bibliographyExportItems(ordered),
    input.format,
    { includeNotes: input.includeNotes ?? false },
  );
  return {
    format: input.format,
    fileName: `references${BIBLIOGRAPHY_FILE_EXTENSIONS[input.format]}`,
    content,
    sourceCount: ordered.length,
    missingSourceIds: missing,
    notKept,
  };
}

/** Written only by the managed bibliography service. */
const MANAGED_BIBLIOGRAPHY_PATHS = new Set(["references.bib", "references.json"]);

/** Default macOS and Windows volumes treat names that differ only in case as one file. */
export function caseInsensitiveFileSystem(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

function protectedExportPathError(relativePath: string, caseInsensitive: boolean): string | null {
  const path = caseInsensitive ? relativePath.toLowerCase() : relativePath;
  if (path === ".scient" || path.startsWith(".scient/")) {
    return "The export path must stay inside the project, outside .scient.";
  }
  if (MANAGED_BIBLIOGRAPHY_PATHS.has(path)) {
    return "references.bib and references.json are kept up to date from the Library by Scient. Choose another file name.";
  }
  return null;
}

/**
 * Writes an export inside the project, never into Library storage, replacing
 * an existing file only when asked. The write is atomic. Protected paths are
 * checked on the requested spelling and again after resolving the folder, so
 * a symlinked folder cannot reach them.
 */
export async function writeProjectBibliographyFile(input: {
  readonly root: string;
  readonly relativePath: string;
  readonly content: string;
  readonly overwrite: boolean;
  readonly caseInsensitive: boolean;
}): Promise<{ readonly outcome: "written" | "exists"; readonly relativePath: string }> {
  const requested = input.relativePath.trim();
  if (
    !requested ||
    requested.includes("\0") ||
    requested.includes("\\") ||
    NodePath.posix.isAbsolute(requested) ||
    NodePath.win32.isAbsolute(requested)
  ) {
    throw new Error("The export path must be a relative project path.");
  }
  const canonicalRoot = await canonicalizeScientSourceRoot(input.root);
  const normalized = NodePath.posix.normalize(requested);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("The export path must stay inside the project, outside .scient.");
  }
  const requestedError = protectedExportPathError(normalized, input.caseInsensitive);
  if (requestedError) throw new Error(requestedError);
  const target = NodePath.join(canonicalRoot, ...normalized.split("/"));
  const directory = await NodeFSP.realpath(NodePath.dirname(target));
  const finalPath = NodePath.join(directory, NodePath.basename(target));
  const relative = NodePath.relative(canonicalRoot, finalPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new Error("The export path must stay inside the project.");
  }
  const resolvedError = protectedExportPathError(
    relative.split(NodePath.sep).join("/"),
    input.caseInsensitive,
  );
  if (resolvedError) throw new Error(resolvedError);
  const existing = await NodeFSP.lstat(finalPath).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("The export path is not a regular file.");
  }
  if (existing && !input.overwrite) return { outcome: "exists", relativePath: normalized };
  const temporary = `${finalPath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, input.content, { encoding: "utf8", flag: "wx" });
    await NodeFSP.rename(temporary, finalPath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  return { outcome: "written", relativePath: normalized };
}
