// @effect-diagnostics nodeBuiltinImport:off -- This owned Promise-based Sources adapter reads bounded reference files from the project filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  bibliographyExportItems,
  detectBibliographyFormat,
  exportBibliographyFile,
  parseBibliography,
  planBibliographyImport,
  withLinkedFileReport,
  BIBLIOGRAPHY_FILE_EXTENSIONS,
  BIBLIOGRAPHY_FILE_MAX_BYTES,
  type BibliographyFormat,
  type BibliographyImportPlan,
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
  SCIENT_SOURCE_LINKED_PDF_LIMIT,
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

/**
 * The folder of an uploaded reference file, when the client named the path it came
 * from on this computer and that file holds exactly the uploaded bytes.
 */
export async function verifiedUploadFolder(
  sourcePath: string | undefined,
  uploadedPath: string,
): Promise<string | undefined> {
  if (!sourcePath || !NodePath.isAbsolute(sourcePath)) return undefined;
  const [claimed, uploaded] = await Promise.all([
    NodeFSP.stat(sourcePath).catch(() => null),
    NodeFSP.stat(uploadedPath),
  ]);
  if (
    !claimed?.isFile() ||
    claimed.size !== uploaded.size ||
    claimed.size > BIBLIOGRAPHY_FILE_MAX_BYTES
  ) {
    return undefined;
  }
  const [claimedBytes, uploadedBytes] = await Promise.all([
    NodeFSP.readFile(sourcePath).catch(() => null),
    NodeFSP.readFile(uploadedPath),
  ]);
  return claimedBytes?.equals(uploadedBytes) ? NodePath.dirname(sourcePath) : undefined;
}

const REFERENCE_FILE_EXTENSIONS = [".bib", ".bibtex", ".biblatex", ".ris", ".json", ".xml", ".txt"];

/** A project reference file; Library storage and the rest of `.scient` are refused. */
export async function resolveProjectBibliographyFile(root: string, relativePath: string) {
  return resolveScientProjectFile(root, relativePath, {
    extensions: REFERENCE_FILE_EXTENSIONS,
    description: "reference file",
  });
}

function insideFolder(folder: string, path: string): boolean {
  const relative = NodePath.relative(folder, path);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

interface LinkedPdf {
  readonly path: string;
  readonly fileName: string;
}

const LINKED_FILE_REASONS = {
  web: "a web link",
  missing: "not found",
  outside: "outside the project and the reference file's folder",
  outsideProject: "outside the project",
  scient: "in Scient's own folder",
  notPdf: "not a PDF",
  tooMany: `more than ${SCIENT_SOURCE_LINKED_PDF_LIMIT} PDFs for one entry`,
} as const;

async function startsAsPdf(path: string): Promise<boolean> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, 5, 0);
    return bytesRead === 5 && header.toString("ascii") === "%PDF-";
  } finally {
    await handle.close();
  }
}

/** EndNote names its PDFs relative to the `PDF` folder inside the library's `.Data` folder. */
async function endnoteInternalPdf(folder: string, rest: string): Promise<string | null> {
  const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
  const parts = rest.split("/").filter(Boolean);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".data")) continue;
    const candidate = NodePath.join(folder, entry.name, "PDF", ...parts);
    const found = await NodeFSP.lstat(candidate).catch(() => null);
    if (found) return candidate;
  }
  return null;
}

/**
 * Finds the PDF a reference file names for an entry. Only a PDF inside the project
 * (outside `.scient`) or inside the reference file's own folder is used; relative
 * paths start from that folder, else from the project.
 */
async function resolveLinkedPdf(
  link: string,
  bases: { readonly root: string; readonly folder: string | null },
): Promise<LinkedPdf | { readonly reason: string }> {
  const value = link.trim();
  if (/^https?:\/\//iu.test(value)) return { reason: LINKED_FILE_REASONS.web };
  const start = bases.folder ?? bases.root;
  let lexical: string | null;
  const internal = value.match(/^internal-pdf:\/\/(.+)$/iu)?.[1];
  if (internal) {
    lexical = await endnoteInternalPdf(start, safeDecodeUri(internal));
  } else if (/^file:/iu.test(value)) {
    lexical = fileUrlPath(value);
  } else {
    lexical = NodePath.isAbsolute(value)
      ? value
      : NodePath.resolve(start, ...value.split(/[\\/]/u).filter(Boolean));
  }
  const real = lexical ? await NodeFSP.realpath(lexical).catch(() => null) : null;
  if (!real) return { reason: LINKED_FILE_REASONS.missing };
  const inProject = insideFolder(bases.root, real);
  if (!inProject && !(bases.folder && insideFolder(bases.folder, real))) {
    return {
      reason: bases.folder ? LINKED_FILE_REASONS.outside : LINKED_FILE_REASONS.outsideProject,
    };
  }
  if (
    inProject &&
    NodePath.relative(bases.root, real)
      .split(NodePath.sep)
      .some((part) => part.toLowerCase() === ".scient")
  ) {
    return { reason: LINKED_FILE_REASONS.scient };
  }
  const stats = await NodeFSP.lstat(real).catch(() => null);
  if (!stats?.isFile()) return { reason: LINKED_FILE_REASONS.missing };
  if (!(await startsAsPdf(real).catch(() => false))) return { reason: LINKED_FILE_REASONS.notPdf };
  return { path: real, fileName: NodePath.basename(real) };
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(value: string): string | null {
  try {
    return NodeURL.fileURLToPath(value);
  } catch {
    return null;
  }
}

/** A filesystem root as "the file's folder" would admit every file on the volume. */
async function referenceFileFolder(folder: string | undefined): Promise<string | null> {
  if (!folder) return null;
  const real = await NodeFSP.realpath(folder).catch(() => null);
  return real && NodePath.parse(real).root !== real ? real : null;
}

async function resolveLinkedPdfs(
  root: string,
  sourceFolder: string | undefined,
  linkedFiles: BibliographyImportPlan["linkedFiles"],
) {
  const bases = { root, folder: await referenceFileFolder(sourceFolder) };
  const pdfs: Record<string, LinkedPdf[]> = {};
  const losses: { field: string; reason: string; label: string }[] = [];
  let pdfCount = 0;
  for (const entry of linkedFiles) {
    const found: LinkedPdf[] = [];
    for (const file of entry.files) {
      const resolved = await resolveLinkedPdf(file.path, bases);
      const reason =
        "reason" in resolved
          ? resolved.reason
          : found.length >= SCIENT_SOURCE_LINKED_PDF_LIMIT
            ? LINKED_FILE_REASONS.tooMany
            : null;
      if (reason) losses.push({ field: file.field, reason, label: entry.label });
      else if ("path" in resolved && !found.some((pdf) => pdf.path === resolved.path)) {
        found.push(resolved);
      }
    }
    if (found.length > 0) {
      pdfs[entry.sourceKey] = found;
      pdfCount += found.length;
    }
  }
  return { pdfs, pdfCount, losses };
}

async function plan(
  root: string,
  input: {
    readonly fileName: string;
    readonly text: string;
    readonly format?: BibliographyFormat;
    readonly sourceFolder?: string;
  },
) {
  const format = input.format ?? detectBibliographyFormat(input.fileName, input.text);
  if (!format) {
    throw new Error(`Scient could not tell what kind of reference file this is. ${FORMAT_HELP}`);
  }
  const existing = await listScientSourceRecords(root);
  // Every listed record belongs to this project, so any one carries its ID.
  const projectId = existing[0]?.projectId;
  const planned = planBibliographyImport({
    parse: parseBibliography(input.text, format),
    existing,
    sourceKeyFor: fileImportSourceKey,
    sourceIdFor: (sourceKey) => (projectId ? scientSourceIdFor(projectId, sourceKey) : sourceKey),
    limit: SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  });
  const linked = await resolveLinkedPdfs(root, input.sourceFolder, planned.linkedFiles);
  return {
    candidates: planned.candidates,
    report: withLinkedFileReport(planned.report, linked),
    pdfs: linked.pdfs,
  };
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
  /** The folder the reference file came from on this computer; PDFs it names inside it are attached. */
  readonly sourceFolder?: string;
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
  const { candidates, report, pdfs } = await plan(root, input);
  if (candidates.length === 0) return { operation: null, report };
  await writeScientSourceStagedFileImport(root, {
    formatVersion: 1,
    operationId: input.operationId,
    fileName: NodePath.basename(input.fileName),
    report,
    candidates: [...candidates],
    ...(Object.keys(pdfs).length > 0 ? { pdfs } : {}),
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
  readonly pdfs: Readonly<Record<string, ReadonlyArray<LinkedPdf>>>;
} | null = null;

/** The staged candidate and its linked PDFs for one operation item; the parsed stage is reused across items. */
export async function getBibliographyFileImportMaterial(
  root: string,
  operationId: string,
  itemKey: string,
): Promise<{
  readonly candidate: ScientSourceCandidate;
  readonly pdfs: ReadonlyArray<LinkedPdf>;
}> {
  const key = `${root}\0${operationId}`;
  if (cachedStage?.key !== key) {
    const staged = await readScientSourceStagedFileImport(root, operationId);
    if (!staged) throw new Error("The reference file for this import is no longer staged.");
    cachedStage = {
      key,
      candidates: new Map(staged.candidates.map((candidate) => [candidate.sourceKey, candidate])),
      pdfs: staged.pdfs ?? {},
    };
  }
  const candidate = cachedStage.candidates.get(itemKey);
  if (!candidate) throw new Error("This entry is not part of the staged reference file.");
  // A linked PDF is used only where it was found at staging, never through a path swapped in since.
  const pdfs: LinkedPdf[] = [];
  for (const pdf of cachedStage.pdfs[itemKey] ?? []) {
    if ((await NodeFSP.realpath(pdf.path).catch(() => null)) === pdf.path) pdfs.push(pdf);
  }
  return { candidate, pdfs };
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
