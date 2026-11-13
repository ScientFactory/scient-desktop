// @effect-diagnostics nodeBuiltinImport:off -- A project package is plain files: JSON, PDFs and a manifest.
// @effect-diagnostics globalDate:off -- Package manifests use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { createScientSourceCollection, readScientSourcesOrganization } from "./collections.ts";
import { resolveScientLibraryAlias, readScientLibraryAliases } from "./libraryAliases.ts";
import {
  recordScientProjectSourceMappings,
  resolveScientProjectSources,
} from "./libraryInstanceMap.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import { scientLibraryMoveInternals } from "./libraryMove.ts";
import { scientReviewNamedIds } from "./libraryReviews.ts";
import { registerScientLibraryInstance, type ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceActor, ScientSourceCandidate, ScientSourceRecord } from "./model.ts";
import {
  decodeScientProjectPinsText,
  joinScientProjectPins,
  scientProjectPinsText,
  withScientProjectPinsLock,
  type ScientProjectPinsJoin,
} from "./projectPins.ts";
import {
  attachScientSourcePdf,
  decodePersistedScientSourceRecord,
  importScientSource,
  readScientSourceRecord,
  scientSourceStoreInternals,
  sourceAttachmentAbsolutePath,
} from "./store.ts";
import { atomicWriteJson, ensureDirectory, isNodeError, readBoundedJson } from "./storeFiles.ts";
import { ScientSystematicReview } from "./systematicReview.ts";

const PROJECT_LIBRARY = ".scient/library";
const PINS = `${PROJECT_LIBRARY}/pins.json`;
const NOTE_HISTORY = `${PROJECT_LIBRARY}/note-history`;
const REVIEWS = `${PROJECT_LIBRARY}/reviews`;
const REVIEW_CONFLICTS = `${PROJECT_LIBRARY}/conflicts/reviews`;
const LIBRARY_ANNOTATIONS = "annotations/v1";
const MANIFEST_FILE = "manifest.json";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const PACKAGE_KIND = "scient-project-package";

const PackageFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
});

const Unavailable = Schema.Struct({
  projectSourceId: Schema.String,
  /** `pdf`: a PDF the record names that this Library does not hold; `record`: only a snapshot. */
  kind: Schema.Literals(["pdf", "record"]),
  sha256: Schema.optionalKey(Schema.String),
  fileName: Schema.optionalKey(Schema.String),
});

export const ScientProjectPackageManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  kind: Schema.Literal(PACKAGE_KIND),
  exportedAt: Schema.String,
  project: Schema.Struct({ projectId: Schema.String, title: Schema.String }),
  counts: Schema.Struct({
    pins: Schema.Int,
    sources: Schema.Int,
    reviewOnlySources: Schema.Int,
    pdfs: Schema.Int,
    annotations: Schema.Int,
    reviews: Schema.Int,
    collections: Schema.Int,
  }),
  files: Schema.Array(PackageFile),
  unavailable: Schema.Array(Unavailable),
});
export type ScientProjectPackageManifest = typeof ScientProjectPackageManifest.Type;

/** One source in the package: the Library record under this project's source ID, no personal note. */
const PackageSource = Schema.Struct({
  formatVersion: Schema.Literal(1),
  projectSourceId: Schema.String,
  pinned: Schema.Boolean,
  record: Schema.Unknown,
});

const PackageOrganization = Schema.Struct({
  formatVersion: Schema.Literal(1),
  collections: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      parentName: Schema.optionalKey(Schema.String),
      projectSourceIds: Schema.Array(Schema.String),
    }),
  ),
});

const decodeReview = Schema.decodeUnknownSync(ScientSystematicReview);
const decodePackageSource = Schema.decodeUnknownSync(PackageSource);
const decodeOrganization = Schema.decodeUnknownSync(PackageOrganization);
const absolute = (base: string, relative: string) => NodePath.join(base, ...relative.split("/"));
const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function hashFile(filePath: string): Promise<string | null> {
  const hash = NodeCrypto.createHash("sha256");
  try {
    for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  return hash.digest("hex");
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

/** Regular files under a folder, slash-separated; links are never followed. */
async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  let entries: NodeFS.Dirent[];
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) => (left.name < right.name ? -1 : 1))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(NodePath.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** The record as the package carries it: no personal note, no reading state. */
function packagedRecord(record: ScientSourceRecord): Record<string, unknown> {
  const {
    note: _personal,
    readingStatus: _read,
    starred: _starred,
    ...rest
  } = record as ScientSourceRecord & {
    readonly readingStatus?: unknown;
    readonly starred?: unknown;
  };
  return rest;
}

function readme(manifest: ScientProjectPackageManifest): string {
  const { counts } = manifest;
  return `# Scient project package: ${manifest.project.title}

Exported ${manifest.exportedAt}. A copy of what this project holds in Scient, for another
computer, a collaborator or a backup: ${counts.pins} sources the project cites with their
citation details, project notes and note history, ${counts.reviews} reviews with their records
and decisions (${counts.reviewOnlySources} sources only a review names), ${counts.pdfs} PDFs with
their highlights, and ${counts.collections} collections they are in. Personal notes, reading
state and the rest of the Library are not included.

- \`project/\`: the project's pins, note history and reviews, as Scient keeps them.
- \`sources/\`: one Library record per source, under this project's source ID.
- \`pdfs/\`, \`annotations/\`: the exact PDFs and their highlight files, by SHA-256.
- \`organization.json\`: the collections these sources are in.
- \`manifest.json\`: every file with its size and SHA-256, and anything that was not available.

To bring it into a project, ask Scient's agent to import it (\`scient_sources_import_file\` with
this folder), or choose Import project package in the Library panel.
`;
}

export interface ScientProjectPackageExport {
  /** Project-relative folder. */
  readonly relativePath: string;
  readonly counts: ScientProjectPackageManifest["counts"];
  readonly unavailable: ScientProjectPackageManifest["unavailable"];
}

/**
 * Writes this project's package to `relativePath` (a folder that must not exist): its pins,
 * note history and reviews, the Library records of every source it pins or a review names, their
 * exact PDFs with highlights, and the collections they are in. Built hidden, checked, then
 * published with one rename. Reads the Library only.
 */
export async function exportScientProjectPackage(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly relativePath: string;
  readonly title?: string;
}): Promise<ScientProjectPackageExport> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const destination = NodePath.resolve(root, input.relativePath);
  const relativePath = NodePath.relative(root, destination).split(NodePath.sep).join("/");
  if (!relativePath || relativePath.startsWith("..") || NodePath.isAbsolute(relativePath)) {
    throw new Error("The package folder must be inside the project.");
  }
  if (relativePath === ".scient" || relativePath.startsWith(".scient/")) {
    throw new Error("The package folder cannot be inside .scient.");
  }
  if (await NodeFSP.lstat(destination).catch(() => null)) {
    throw new Error(`${relativePath} already exists.`);
  }
  const staging = NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.${NodeCrypto.randomUUID()}.partial`,
  );
  await ensureDirectory(staging);
  try {
    const manifest = await buildPackage({ ...input, root, projectId, staging });
    await NodeFSP.rename(staging, destination);
    return { relativePath, counts: manifest.counts, unavailable: manifest.unavailable };
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

async function buildPackage(input: {
  readonly root: string;
  readonly projectId: string;
  readonly staging: string;
  readonly library: ScientLibraryLocation;
  readonly title?: string;
}): Promise<ScientProjectPackageManifest> {
  const { root, staging, library } = input;
  const files: Array<typeof PackageFile.Type> = [];
  const unavailable: Array<typeof Unavailable.Type> = [];
  const put = async (path: string, bytes: Buffer | string) => {
    const target = absolute(staging, path);
    await ensureDirectory(NodePath.dirname(target));
    await NodeFSP.writeFile(target, bytes);
    const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    files.push({
      path,
      sha256: NodeCrypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.byteLength,
    });
  };
  const copy = async (from: string, path: string): Promise<boolean> => {
    const sha256 = await hashFile(from);
    if (sha256 === null) return false;
    const target = absolute(staging, path);
    await ensureDirectory(NodePath.dirname(target));
    await NodeFSP.copyFile(from, target);
    if ((await hashFile(target)) !== sha256) throw new Error(`${path} did not copy whole.`);
    files.push({ path, sha256, bytes: (await NodeFSP.stat(target)).size });
    return true;
  };

  const pinsText = await readText(absolute(root, PINS));
  const pins = pinsText === null ? [] : decodeScientProjectPinsText(pinsText);
  if (pinsText !== null) await put("project/pins.json", pinsText);
  for (const file of await listFiles(absolute(root, NOTE_HISTORY))) {
    await copy(absolute(root, `${NOTE_HISTORY}/${file}`), `project/note-history/${file}`);
  }
  const reviewIds = new Set<string>();
  let reviews = 0;
  for (const file of await listFiles(absolute(root, REVIEWS))) {
    await copy(absolute(root, `${REVIEWS}/${file}`), `project/reviews/${file}`);
    if (!file.includes("/") && file.endsWith(".json") && !file.endsWith(".works.json")) {
      const review = decodeReview(
        JSON.parse((await readText(absolute(root, `${REVIEWS}/${file}`)))!),
      );
      if (review.deletedAt !== undefined) continue;
      reviews += 1;
      for (const id of scientReviewNamedIds(review)) reviewIds.add(id);
    }
  }

  const pinned = new Set(pins.map((pin) => pin.sourceId));
  const requests = [
    ...pins.map((pin) => ({ projectSourceId: pin.sourceId, work: pin.work })),
    ...[...reviewIds]
      .filter((id) => !pinned.has(id))
      .map((id) => ({ projectSourceId: id, work: null })),
  ];
  const resolutions = await resolveScientProjectSources({
    library,
    projectRoot: root,
    mode: "read",
    sources: requests,
  });
  const libraryIds = new Map<string, string>();
  const annotationsDirectory = absolute(library.root, LIBRARY_ANNOTATIONS);
  const pdfs = new Set<string>();
  let annotations = 0;
  let sources = 0;
  for (const [index, request] of requests.entries()) {
    const resolution = resolutions[index]!;
    const record =
      resolution.kind === "resolved"
        ? await readScientSourceRecord(library, resolution.sourceId)
        : null;
    if (!record) {
      unavailable.push({ projectSourceId: request.projectSourceId, kind: "record" });
      continue;
    }
    libraryIds.set(record.sourceId, request.projectSourceId);
    sources += 1;
    await put(
      `sources/${request.projectSourceId}.json`,
      formatJson({
        formatVersion: 1,
        projectSourceId: request.projectSourceId,
        pinned: pinned.has(request.projectSourceId),
        record: packagedRecord(record),
      }),
    );
    for (const attachment of record.attachments) {
      if (pdfs.has(attachment.sha256)) continue;
      const copied = await copy(
        sourceAttachmentAbsolutePath(library, attachment),
        `pdfs/${attachment.sha256}.pdf`,
      ).catch(() => false);
      if (!copied) {
        unavailable.push({
          projectSourceId: request.projectSourceId,
          kind: "pdf",
          sha256: attachment.sha256,
          fileName: attachment.fileName,
        });
        continue;
      }
      pdfs.add(attachment.sha256);
      if (
        await copy(
          NodePath.join(annotationsDirectory, `${attachment.sha256}.json`),
          `annotations/${attachment.sha256}.json`,
        )
      ) {
        annotations += 1;
      }
    }
  }

  const organization = await readScientSourcesOrganization(library);
  const names = new Map(organization.collections.map((entry) => [entry.collectionId, entry.name]));
  const collections = organization.collections.flatMap((collection) => {
    const projectSourceIds = collection.sourceIds.flatMap((id) => {
      const projectSourceId = libraryIds.get(id);
      return projectSourceId ? [projectSourceId] : [];
    });
    if (projectSourceIds.length === 0) return [];
    const parentName = collection.parentCollectionId
      ? names.get(collection.parentCollectionId)
      : undefined;
    return [{ name: collection.name, ...(parentName ? { parentName } : {}), projectSourceIds }];
  });
  await put("organization.json", formatJson({ formatVersion: 1, collections }));

  const manifest: ScientProjectPackageManifest = {
    formatVersion: 1,
    kind: PACKAGE_KIND,
    exportedAt: new Date().toISOString(),
    project: { projectId: input.projectId, title: input.title?.trim() || NodePath.basename(root) },
    counts: {
      pins: pins.length,
      sources,
      reviewOnlySources: requests.length - pins.length,
      pdfs: pdfs.size,
      annotations,
      reviews,
      collections: collections.length,
    },
    files,
    unavailable,
  };
  await NodeFSP.writeFile(NodePath.join(staging, "README.md"), readme(manifest), "utf8");
  await atomicWriteJson(NodePath.join(staging, MANIFEST_FILE), manifest, MAX_JSON_BYTES);
  return manifest;
}

/** A package's manifest, or null when the folder is not one. */
async function readScientProjectPackageManifest(
  folder: string,
): Promise<ScientProjectPackageManifest | null> {
  try {
    return await readBoundedJson(
      NodePath.join(folder, MANIFEST_FILE),
      MAX_JSON_BYTES,
      ScientProjectPackageManifest,
    );
  } catch {
    return null;
  }
}

/** The packages in the project's top-level folders, newest first. */
export async function listScientProjectPackages(projectRoot: string): Promise<
  ReadonlyArray<{
    readonly relativePath: string;
    readonly title: string;
    readonly exportedAt: string;
  }>
> {
  const root = await NodeFSP.realpath(projectRoot);
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifest = await readScientProjectPackageManifest(NodePath.join(root, entry.name));
    if (manifest) {
      found.push({
        relativePath: entry.name,
        title: manifest.project.title,
        exportedAt: manifest.exportedAt,
      });
    }
  }
  return found.toSorted((left, right) => (left.exportedAt < right.exportedAt ? 1 : -1));
}

export type ScientProjectPackageImport =
  | {
      readonly outcome: "imported";
      readonly sources: { readonly added: number; readonly matched: number };
      readonly pdfs: { readonly added: number; readonly present: number };
      readonly annotations: number;
      readonly pins: ScientProjectPinsJoin;
      readonly reviews: { readonly added: number; readonly conflicts: number };
      readonly collections: number;
      /** What the exporting computer could not include. */
      readonly unavailable: ScientProjectPackageManifest["unavailable"];
    }
  | { readonly outcome: "not-a-package" }
  | { readonly outcome: "package-changed"; readonly files: ReadonlyArray<string> };

function candidateFrom(record: ScientSourceRecord, projectSourceId: string): ScientSourceCandidate {
  return {
    sourceKey: `project-package:${projectSourceId}`,
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    type: record.type,
    customType: record.customType ?? null,
    title: record.title,
    creators: record.creators,
    issuedRaw: record.issuedRaw,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    abstract: record.abstract,
    containerTitle: record.containerTitle,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
    externalReferences: record.externalReferences,
    fieldProvenance: record.fieldProvenance,
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

/**
 * Brings a checked package into this project and Library: a source the Library has is matched and
 * gets the PDFs it lacks, others are added; highlights join by annotation ID; pins, notes and
 * reviews join this project's own. Needs neither the exporting Library nor a move journal.
 */
export async function importScientProjectPackage(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly folder: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientProjectPackageImport> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const folder = await NodeFSP.realpath(input.folder).catch(() => input.folder);
  const manifest = await readScientProjectPackageManifest(folder);
  if (!manifest) return { outcome: "not-a-package" };
  const changed: string[] = [];
  for (const file of manifest.files) {
    if ((await hashFile(absolute(folder, file.path))) !== file.sha256) changed.push(file.path);
  }
  if (changed.length > 0) return { outcome: "package-changed", files: changed };
  const { library } = input;
  const { instanceId } = await registerScientLibraryInstance({
    library,
    projectId,
    projectRoot: root,
  });

  const sourceFiles = manifest.files.filter((file) => /^sources\/[^/]+\.json$/u.test(file.path));
  const packaged = await Promise.all(
    sourceFiles.map(async (file) => {
      const entry = decodePackageSource(JSON.parse((await readText(absolute(folder, file.path)))!));
      return {
        projectSourceId: entry.projectSourceId,
        record: decodePersistedScientSourceRecord(entry.record),
      };
    }),
  );
  const resolutions = await resolveScientProjectSources({
    library,
    projectRoot: root,
    mode: "read",
    sources: packaged.map(({ projectSourceId, record }) => ({ projectSourceId, work: record })),
  });
  const aliases = await readScientLibraryAliases(library);
  const mapped = new Map<string, string>();
  let added = 0;
  let matched = 0;
  let pdfsAdded = 0;
  let pdfsPresent = 0;
  for (const [index, { projectSourceId, record }] of packaged.entries()) {
    const resolution = resolutions[index]!;
    const sameId = await readScientSourceRecord(
      library,
      resolveScientLibraryAlias(aliases, record.sourceId),
    );
    let target =
      sameId ??
      (resolution.kind === "resolved"
        ? await readScientSourceRecord(library, resolution.sourceId)
        : null);
    if (target) {
      matched += 1;
    } else {
      const imported = await importScientSource({
        root: library,
        operationId: `package_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: candidateFrom(record, projectSourceId),
        actor: input.actor,
        intake: "file",
        // A title-and-author likeness is not identity; a shared identifier or PDF is.
        allowPossibleMetadataMatch: true,
      });
      const existingId =
        imported.duplicate.matchingSourceIds.length === 1
          ? imported.duplicate.matchingSourceIds[0]!
          : null;
      target =
        imported.record ?? (existingId ? await readScientSourceRecord(library, existingId) : null);
      if (!target) continue;
      if (imported.record) added += 1;
      else matched += 1;
    }
    mapped.set(projectSourceId, target.sourceId);
    for (const attachment of record.attachments) {
      if (target.attachments.some((entry) => entry.sha256 === attachment.sha256)) {
        pdfsPresent += 1;
        continue;
      }
      const pdf = absolute(folder, `pdfs/${attachment.sha256}.pdf`);
      if ((await hashFile(pdf)) !== attachment.sha256) continue;
      const attached = await attachScientSourcePdf({
        root: library,
        sourceId: target.sourceId,
        expectedRevision: target.revision,
        pdfPath: pdf,
        fileName: attachment.fileName,
        actor: input.actor,
        ...(attachment.retrieval ? { retrieval: attachment.retrieval } : {}),
      });
      target = attached.record;
      pdfsAdded += 1;
    }
  }
  await withScientLibraryLock(library.root, () =>
    recordScientProjectSourceMappings({
      library,
      instanceId,
      mappings: [...mapped].map(([projectSourceId, sourceId]) => ({ projectSourceId, sourceId })),
    }),
  );

  const annotations = await importAnnotations(library, folder, manifest);
  const pins = await importProjectFiles(root, folder, manifest);
  const reviews = await importReviews(root, folder, manifest);
  const organization = (await readText(absolute(folder, "organization.json"))) ?? "";
  let collections = 0;
  const document = organization
    ? decodeOrganization(JSON.parse(organization))
    : { collections: [] };
  const createdIds = new Map<string, string>();
  for (const collection of document.collections.toSorted(
    (left, right) => Number(left.parentName !== undefined) - Number(right.parentName !== undefined),
  )) {
    const sourceIds = collection.projectSourceIds.flatMap((id) => {
      const sourceId = mapped.get(id);
      return sourceId ? [sourceId] : [];
    });
    if (sourceIds.length === 0) continue;
    const parentCollectionId = collection.parentName
      ? createdIds.get(collection.parentName)
      : undefined;
    const created = await createScientSourceCollection({
      root: library,
      name: collection.name,
      sourceIds,
      ...(parentCollectionId ? { parentCollectionId } : {}),
      actor: input.actor,
    });
    if (created.collection) {
      createdIds.set(collection.name, created.collection.collectionId);
      collections += 1;
    }
  }
  return {
    outcome: "imported",
    sources: { added, matched },
    pdfs: { added: pdfsAdded, present: pdfsPresent },
    annotations,
    pins,
    reviews,
    collections,
    unavailable: manifest.unavailable,
  };
}

async function importAnnotations(
  library: ScientLibraryLocation,
  folder: string,
  manifest: ScientProjectPackageManifest,
): Promise<number> {
  const { annotationFile, mergeAnnotationFiles } = scientLibraryMoveInternals;
  let count = 0;
  for (const file of manifest.files) {
    const match = /^annotations\/([0-9a-f]{64})\.json$/u.exec(file.path);
    if (!match) continue;
    const sha256 = match[1]!;
    const incoming = annotationFile(
      JSON.parse((await readText(absolute(folder, file.path)))!),
      sha256,
    );
    if (!incoming) continue;
    await withScientLibraryLock(library.root, async () => {
      const target = absolute(library.root, `${LIBRARY_ANNOTATIONS}/${sha256}.json`);
      const existingText = await readText(target);
      const existing = existingText ? annotationFile(JSON.parse(existingText), sha256) : null;
      await atomicWriteJson(
        target,
        existing ? mergeAnnotationFiles(existing, incoming) : incoming,
        MAX_JSON_BYTES,
      );
    });
    count += 1;
  }
  return count;
}

/** Pins and note history: a project without them takes the package's files as they are. */
async function importProjectFiles(
  root: string,
  folder: string,
  manifest: ScientProjectPackageManifest,
): Promise<ScientProjectPinsJoin> {
  const pinsText = manifest.files.some((file) => file.path === "project/pins.json")
    ? await readText(absolute(folder, "project/pins.json"))
    : null;
  const incoming = pinsText === null ? [] : decodeScientProjectPinsText(pinsText);
  await withScientProjectPinsLock(root, async () => {
    for (const file of manifest.files) {
      if (!file.path.startsWith("project/note-history/")) continue;
      const target = absolute(
        root,
        `${NOTE_HISTORY}/${file.path.slice("project/note-history/".length)}`,
      );
      if ((await readText(target)) !== null) continue;
      await ensureDirectory(NodePath.dirname(target));
      await NodeFSP.copyFile(absolute(folder, file.path), target, NodeFS.constants.COPYFILE_EXCL);
    }
  });
  if ((await readText(absolute(root, PINS))) === null && incoming.length > 0) {
    await withScientProjectPinsLock(root, async () => {
      if ((await readText(absolute(root, PINS))) !== null) return;
      await ensureDirectory(absolute(root, PROJECT_LIBRARY));
      // The same bytes every pin write produces, so the next write shows no diff.
      const temporary = `${absolute(root, PINS)}.${NodeCrypto.randomUUID()}.tmp`;
      try {
        await NodeFSP.writeFile(temporary, scientProjectPinsText(incoming), { flag: "wx" });
        await NodeFSP.rename(temporary, absolute(root, PINS));
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    });
    return { added: incoming.length, notesAdded: 0, notesKept: 0, renamedKeys: [] };
  }
  return joinScientProjectPins({ projectRoot: root, pins: incoming });
}

/** A review this project lacks is added; one that differs waits as a review conflict. */
async function importReviews(
  root: string,
  folder: string,
  manifest: ScientProjectPackageManifest,
): Promise<{ readonly added: number; readonly conflicts: number }> {
  let added = 0;
  let conflicts = 0;
  await scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, async () => {
    const files = manifest.files.filter((file) => file.path.startsWith("project/reviews/"));
    const reviewIds = files.flatMap((file) => {
      const match = /^project\/reviews\/([^/]+)\.json$/u.exec(file.path);
      return match && !match[1]!.endsWith(".works") ? [match[1]!] : [];
    });
    for (const reviewId of reviewIds) {
      const own = await readText(absolute(root, `${REVIEWS}/${reviewId}.json`));
      const theirs = (await readText(absolute(folder, `project/reviews/${reviewId}.json`)))!;
      const related = files.filter(
        (file) =>
          file.path === `project/reviews/${reviewId}.json` ||
          file.path.startsWith(`project/reviews/${reviewId}.works`),
      );
      if (own === theirs) continue;
      const base = own === null ? REVIEWS : `${REVIEW_CONFLICTS}/${reviewId}`;
      const tag = NodeCrypto.createHash("sha256").update(theirs).digest("hex").slice(0, 12);
      for (const file of related) {
        const name = file.path.slice("project/reviews/".length);
        const target =
          own === null
            ? absolute(root, `${base}/${name}`)
            : absolute(root, `${base}/${name.replace(reviewId, tag)}`);
        await ensureDirectory(NodePath.dirname(target));
        await NodeFSP.copyFile(absolute(folder, file.path), target).catch(() => undefined);
      }
      if (own === null) added += 1;
      else conflicts += 1;
    }
  });
  return { added, conflicts };
}
