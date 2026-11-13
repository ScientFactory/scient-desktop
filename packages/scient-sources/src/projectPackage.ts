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
  newScientPackageImportId,
  writeScientProjectPackageReceipt,
  type ScientProjectPackageFailure,
} from "./projectPackageReceipt.ts";
import {
  decodeScientProjectPinsText,
  joinScientProjectPins,
  readScientProjectPins,
  type ScientProjectPinsJoin,
} from "./projectPins.ts";
import {
  attachScientSourcePdf,
  decodePersistedScientSourceRecord,
  importScientSource,
  listScientSourceRecords,
  readScientSourceIntakeExclusions,
  readScientSourceRecord,
  recordScientSourceCheck,
  scientSourceStoreInternals,
  updateScientSourceMetadata,
  sourceAttachmentAbsolutePath,
} from "./store.ts";
import { atomicWriteJson, ensureDirectory, isNodeError, readBoundedJson } from "./storeFiles.ts";
import { editableMetadataFromRecord } from "./editable.ts";
import { scientLibraryIdentityProblem } from "./sourceIdentity.ts";
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

/** Collections with their ancestors, under the exporting Library's IDs; parents may hold none. */
const PackageOrganization = Schema.Struct({
  formatVersion: Schema.Literal(1),
  collections: Schema.Array(
    Schema.Struct({
      collectionId: Schema.optionalKey(Schema.String),
      name: Schema.String,
      parentId: Schema.optionalKey(Schema.String),
      /** Packages written before IDs name the parent only. */
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
their highlights, and ${counts.collections} collections they are in, with the collections
around them. Personal notes, reading state, saved searches and the rest of the Library are not
included.

- \`project/\`: the project's pins, note history and reviews, as Scient keeps them.
- \`sources/\`: one Library record per source, under this project's source ID.
- \`pdfs/\`, \`annotations/\`: the exact PDFs and their highlight files, by SHA-256.
- \`organization.json\`: the collections these sources are in.
- \`manifest.json\`: every file with its size and SHA-256, and anything that was not available.

To bring it into a project, choose Project package > Import a package in the Library panel, or
ask Scient's agent to import it (\`scient_sources_organize\` with change \`{ "action":
"import-package", "relativePath": "<this folder>" }\`). Import keeps a receipt; Undo removes what
it added.
`;
}

export interface ScientProjectPackageExport {
  /** Project-relative folder, or the absolute path of one outside the project. */
  readonly relativePath: string;
  readonly insideProject: boolean;
  readonly counts: ScientProjectPackageManifest["counts"];
  readonly unavailable: ScientProjectPackageManifest["unavailable"];
}

/**
 * Writes this project's package to a new folder, in the project (committed with it) or anywhere
 * else: pins, note history, reviews, the records of every source pinned or reviewed, their exact
 * PDFs with highlights, and their collections. Built hidden, checked, published by one rename.
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
  const inside = NodePath.relative(root, destination).split(NodePath.sep).join("/");
  const outside = !inside || inside.startsWith("..") || NodePath.isAbsolute(inside);
  if (!outside && (inside === ".scient" || inside.startsWith(".scient/"))) {
    throw new Error("The package folder cannot be inside .scient.");
  }
  if (outside && destination === root) throw new Error("Choose a new folder for the package.");
  const relativePath = outside ? destination : inside;
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
    return {
      relativePath,
      insideProject: !outside,
      counts: manifest.counts,
      unavailable: manifest.unavailable,
    };
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
  const live = organization.collections;
  const byId = new Map(live.map((collection) => [collection.collectionId, collection]));
  const membersOf = (collection: (typeof live)[number]) =>
    collection.sourceIds.flatMap((id) => {
      const projectSourceId = libraryIds.get(id);
      return projectSourceId ? [projectSourceId] : [];
    });
  const needed = new Set<string>();
  for (const collection of live) {
    if (membersOf(collection).length === 0) continue;
    for (
      let current: (typeof live)[number] | undefined = collection;
      current && !needed.has(current.collectionId);
      current = current.parentCollectionId ? byId.get(current.parentCollectionId) : undefined
    ) {
      needed.add(current.collectionId);
    }
  }
  const collections = live
    .filter((collection) => needed.has(collection.collectionId))
    .map((collection) => ({
      collectionId: collection.collectionId,
      name: collection.name,
      ...(collection.parentCollectionId && needed.has(collection.parentCollectionId)
        ? { parentId: collection.parentCollectionId }
        : {}),
      projectSourceIds: membersOf(collection),
    }));
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
      /** Undo takes it (`undoScientProjectPackageImport`). */
      readonly importId: string;
      readonly sources: { readonly added: number; readonly matched: number };
      readonly pdfs: { readonly added: number; readonly present: number };
      readonly annotations: number;
      /** Highlights changed differently on both sides: this Library's stays, the other is history. */
      readonly annotationConflicts: number;
      readonly pins: ScientProjectPinsJoin;
      readonly reviews: {
        readonly added: number;
        readonly conflicts: number;
        readonly snapshotsAdded: number;
      };
      readonly collections: number;
      /** What the exporting computer could not include. */
      readonly unavailable: ScientProjectPackageManifest["unavailable"];
      /** What could not be imported here; never counted above. */
      readonly failed: ReadonlyArray<ScientProjectPackageFailure>;
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
    ...(record.abstractSections ? { abstractSections: record.abstractSections } : {}),
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
 * A proposed target as it is now, when the shared rule takes it for the packaged record: their
 * facts corroborate and no Library decision (Not duplicates, an undone merge) keeps the two apart.
 * Read under the Library lock; later writes are conditioned on the revision it returns. A stable
 * ID or an earlier mapping is never proof alone.
 */
async function packageTargetHolds(
  library: ScientLibraryLocation,
  incoming: ScientSourceRecord,
  targetId: string,
): Promise<ScientSourceRecord | null> {
  return withScientLibraryLock(library.root, async () => {
    const existing = await listScientSourceRecords(library);
    const target = existing.find((record) => record.sourceId === targetId);
    if (!target) return null;
    if (incoming.sourceId !== target.sourceId) {
      const exclusions = await readScientSourceIntakeExclusions(library, existing);
      if (
        exclusions?.isDistinct(incoming.sourceId, target.sourceId) ||
        exclusions?.keptApart(incoming.sourceId, target.sourceId)
      ) {
        return null;
      }
    }
    return scientLibraryIdentityProblem(incoming, target) === null ? target : null;
  });
}

const EDITORIAL_RANK = ["none", "corrected", "expression-of-concern", "withdrawn", "retracted"];

/**
 * A matched record's check joined with the package's, each part on its own: every notice either
 * side knows stays (a local check never drops an incoming retraction), the gravest state wins, and
 * a verification made here wins over a carried one unless this computer never checked. What came
 * only from the package is marked carried. Null when the package adds nothing.
 */
function scientPackageCheckJoin(
  local: Pick<ScientSourceRecord, "verification" | "editorialStatus">,
  incoming: Pick<ScientSourceRecord, "verification" | "editorialStatus">,
  at: string,
): {
  readonly verification: NonNullable<ScientSourceRecord["verification"]>;
  readonly editorialStatus: NonNullable<ScientSourceRecord["editorialStatus"]> | null;
} | null {
  const takeVerification =
    incoming.verification !== undefined &&
    incoming.verification.state !== "unchecked" &&
    (local.verification === undefined || local.verification.state === "unchecked");
  const verification = takeVerification
    ? { ...incoming.verification!, carriedAt: at }
    : local.verification;
  const noticeKey = (notice: { kind: string; doi?: string; date?: string }) =>
    `${notice.kind}\0${notice.doi ?? ""}\0${notice.date ?? ""}`;
  const localNotices = local.editorialStatus?.notices ?? [];
  const known = new Set(localNotices.map(noticeKey));
  const added = (incoming.editorialStatus?.notices ?? []).filter(
    (notice) => !known.has(noticeKey(notice)),
  );
  const graver =
    incoming.editorialStatus !== undefined &&
    EDITORIAL_RANK.indexOf(incoming.editorialStatus.state) >
      EDITORIAL_RANK.indexOf(local.editorialStatus?.state ?? "none");
  const takeEditorial =
    incoming.editorialStatus !== undefined &&
    (local.editorialStatus === undefined || added.length > 0 || graver);
  if (!takeVerification && !takeEditorial) return null;
  const editorialStatus = takeEditorial
    ? {
        ...(local.editorialStatus ?? incoming.editorialStatus!),
        state: graver ? incoming.editorialStatus!.state : local.editorialStatus!.state,
        notices: [...localNotices, ...added].slice(0, 64),
        carriedAt: at,
      }
    : (local.editorialStatus ?? null);
  return {
    verification: verification ?? { state: "unchecked" },
    editorialStatus,
  };
}

/** What the import left, so its Undo removes only what nobody changed since. */
async function importedVersions(
  library: ScientLibraryLocation,
  root: string,
  state: ImportState,
  addedKeys: ReadonlyArray<string>,
) {
  const touched = new Set([
    ...state.receipt.sources,
    ...state.receipt.pdfs.map((pdf) => pdf.sourceId),
  ]);
  const sources = [];
  for (const sourceId of touched) {
    const record = await readScientSourceRecord(library, sourceId);
    if (record) sources.push({ sourceId, revision: record.revision });
  }
  const pinned = new Map(
    (await readScientProjectPins(root)).map((pin) => [pin.citationKey, pin] as const),
  );
  const pins = addedKeys.flatMap((citationKey) => {
    const pin = pinned.get(citationKey);
    return pin ? [{ citationKey, sourceId: pin.sourceId, note: pin.note ?? null }] : [];
  });
  return { sources, pins, collections: state.collectionVersions };
}

/** Another computer's check, marked as brought here, never as a check made here. */
function carried(record: ScientSourceRecord, at: string) {
  return {
    ...(record.verification ? { verification: { ...record.verification, carriedAt: at } } : {}),
    ...(record.editorialStatus
      ? { editorialStatus: { ...record.editorialStatus, carriedAt: at } }
      : {}),
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "It could not be imported.";

/** Copies to a hidden name, checks the bytes, then renames; never over an existing file. */
async function publishCopy(from: string, to: string, sha256: string): Promise<void> {
  await ensureDirectory(NodePath.dirname(to));
  const temporary = `${to}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.copyFile(from, temporary, NodeFS.constants.COPYFILE_EXCL);
    if ((await hashFile(temporary)) !== sha256) throw new Error(`${to} did not copy whole.`);
    if (await NodeFSP.lstat(to).catch(() => null)) throw new Error(`${to} already exists.`);
    await NodeFSP.rename(temporary, to);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

interface ImportState {
  readonly folder: string;
  readonly receipt: {
    sources: string[];
    pdfs: Array<{ sourceId: string; attachmentId: string }>;
    annotationFiles: Array<{ path: string; sha256: string }>;
    reviewFiles: Array<{ path: string; sha256: string }>;
    collections: string[];
  };
  /** Each created collection's version as this import left it. */
  readonly collectionVersions: Array<{ collectionId: string; updatedAt: string }>;
  /** Existing records the import joined, which an earlier import's Undo then keeps. */
  readonly joinedSourceIds: Set<string>;
  readonly failed: ScientProjectPackageFailure[];
}

/**
 * Brings a checked package in as evidence from another computer: a source joins a record only by
 * the shared identity rule (never title likeness), else it is added; highlights, note histories
 * and reviews join without overwriting anything. A receipt lists what was added, for Undo.
 */
export async function importScientProjectPackage(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly folder: string;
  readonly actor: ScientSourceActor;
  /** Test-only: runs once the project's pins lock is held. */
  readonly afterPinsLock?: () => Promise<void>;
}): Promise<ScientProjectPackageImport> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const folder = await NodeFSP.realpath(input.folder).catch(() => input.folder);
  const manifest = await readScientProjectPackageManifest(folder);
  if (!manifest) return { outcome: "not-a-package" };
  const changed: string[] = [];
  for (const file of manifest.files) {
    if (
      !safePackagePath(file.path) ||
      (await hashFile(absolute(folder, file.path))) !== file.sha256
    ) {
      changed.push(file.path);
    }
  }
  if (changed.length > 0) return { outcome: "package-changed", files: changed };
  const { library } = input;
  const { instanceId } = await registerScientLibraryInstance({
    library,
    projectId,
    projectRoot: root,
  });
  const importId = newScientPackageImportId();
  const importedAt = new Date().toISOString();
  const state: ImportState = {
    folder,
    receipt: { sources: [], pdfs: [], annotationFiles: [], reviewFiles: [], collections: [] },
    collectionVersions: [],
    joinedSourceIds: new Set(),
    failed: [],
  };

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
  let matched = 0;
  let pdfsPresent = 0;
  for (const [index, { projectSourceId, record }] of packaged.entries()) {
    try {
      const resolution = resolutions[index]!;
      const sameId = resolveScientLibraryAlias(aliases, record.sourceId);
      // Title likeness is no identity here; every other proposed target is checked again.
      const resolvedId =
        resolution.kind === "resolved" && resolution.by !== "metadata" ? resolution.sourceId : null;
      const proposed = (await readScientSourceRecord(library, sameId)) ? sameId : resolvedId;
      let target = proposed ? await packageTargetHolds(library, record, proposed) : null;
      // A contradicted target: the paper becomes its own record, never that one by its key.
      const contradicted = proposed !== null && target === null;
      if (target) {
        matched += 1;
        state.joinedSourceIds.add(target.sourceId);
        const checked = scientPackageCheckJoin(target, record, importedAt);
        if (checked) {
          const result = await recordScientSourceCheck({
            root: library,
            sourceId: target.sourceId,
            expectedRevision: target.revision,
            verification: checked.verification,
            editorialStatus: checked.editorialStatus,
            actor: input.actor,
          });
          if (result.outcome === "stale") {
            state.failed.push({
              part: "source",
              item: projectSourceId,
              message: "It changed while its notices were brought in; import the package again.",
            });
          }
          target = result.record;
        }
        // An abstract only the package knows comes along, with where it came from.
        if (target.abstract === null && record.abstract !== null) {
          const provenance = record.fieldProvenance.filter((entry) => entry.field === "abstract");
          const edited = await updateScientSourceMetadata({
            root: library,
            sourceId: target.sourceId,
            expectedRevision: target.revision,
            metadata: { ...editableMetadataFromRecord(target), abstract: record.abstract },
            ...(provenance.length > 0 ? { fieldProvenance: provenance } : {}),
            actor: input.actor,
          }).catch(() => null);
          if (edited?.outcome === "updated") target = edited.record;
        }
      } else {
        const imported = await importScientSource({
          root: library,
          operationId: `package_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
          candidate: candidateFrom(
            record,
            contradicted ? `${projectSourceId}:${importId}` : projectSourceId,
          ),
          actor: input.actor,
          intake: "file",
          // Title likeness alone adds a new source; the shared rule decides any other match.
          allowPossibleMetadataMatch: true,
          ...carried(record, importedAt),
        });
        const reused =
          imported.record === null && imported.duplicate.kind !== "new"
            ? imported.duplicate.matchingSourceIds[0]
            : undefined;
        target = imported.record ?? (reused ? await readScientSourceRecord(library, reused) : null);
        if (!target) {
          state.failed.push({
            part: "source",
            item: projectSourceId,
            message: imported.duplicate.reason,
          });
          continue;
        }
        if (imported.record) state.receipt.sources.push(imported.record.sourceId);
        else {
          matched += 1;
          state.joinedSourceIds.add(target.sourceId);
        }
      }
      mapped.set(projectSourceId, target.sourceId);
      for (const attachment of record.attachments) {
        if (target.attachments.some((entry) => entry.sha256 === attachment.sha256)) {
          pdfsPresent += 1;
          continue;
        }
        const pdf = absolute(folder, `pdfs/${attachment.sha256}.pdf`);
        if ((await hashFile(pdf)) !== attachment.sha256) continue;
        try {
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
          const added = attached.record.attachments.find(
            (entry) => entry.sha256 === attachment.sha256,
          );
          if (attached.outcome === "attached" && added) {
            state.receipt.pdfs.push({
              sourceId: target.sourceId,
              attachmentId: added.attachmentId,
            });
          } else if (!added) {
            state.failed.push({
              part: "pdf",
              item: `pdfs/${attachment.sha256}.pdf`,
              message: attached.outcome,
            });
          }
        } catch (error) {
          state.failed.push({
            part: "pdf",
            item: `pdfs/${attachment.sha256}.pdf`,
            message: message(error),
          });
        }
      }
    } catch (error) {
      state.failed.push({ part: "source", item: projectSourceId, message: message(error) });
    }
  }
  await withScientLibraryLock(library.root, () =>
    recordScientProjectSourceMappings({
      library,
      instanceId,
      mappings: [...mapped].map(([projectSourceId, sourceId]) => ({ projectSourceId, sourceId })),
    }),
  );

  const annotations = await importAnnotations(library, manifest, state, importedAt);
  const pins = await importProjectFiles(root, manifest, state, input.afterPinsLock);
  const reviews = await importReviews(root, manifest, state);
  const collections = await importCollections(library, mapped, input.actor, state);
  const pdfsAdded = state.receipt.pdfs.length;
  await writeScientProjectPackageReceipt(library, {
    formatVersion: 1,
    importId,
    importedAt,
    importedBy: input.actor,
    projectId,
    packageTitle: manifest.project.title,
    added: {
      ...state.receipt,
      pins: pins.addedKeys,
      versions: await importedVersions(library, root, state, pins.addedKeys),
    },
    joined: {
      sourceIds: [...state.joinedSourceIds],
      pinKeys: [...pins.joinedKeys],
      sources: matched,
      pdfs: pdfsPresent,
      annotationConflicts: annotations.conflicts,
      notesKept: pins.notesKept,
      historyAdded: pins.historyAdded,
      reviewVersionsKept: reviews.conflicts,
    },
    failed: state.failed,
  });
  return {
    outcome: "imported",
    importId,
    sources: { added: state.receipt.sources.length, matched },
    pdfs: { added: pdfsAdded, present: pdfsPresent },
    annotations: annotations.joined,
    annotationConflicts: annotations.conflicts,
    pins,
    reviews,
    collections,
    unavailable: manifest.unavailable,
    failed: state.failed,
  };
}

/** Slash-separated, inside the package: no root, drive, backslash or `..` segment. */
function safePackagePath(path: string): boolean {
  return (
    !/[\\:\0]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameMark = (left: JsonObject, right: JsonObject) =>
  left["highlighted"] === right["highlighted"] && left["note"] === right["note"];

/** Whether a file's history holds `annotation` as it was at its revision: that branch went on from it. */
const continues = (file: JsonObject, annotation: JsonObject) =>
  (file["history"] as unknown[]).some(
    (entry) =>
      isObject(entry) &&
      entry["annotationId"] === annotation["annotationId"] &&
      entry["revision"] === annotation["revision"] &&
      sameMark(entry, annotation),
  );

/** The other computer's version, marked as brought so the reader offers it. */
function historyEntry(annotation: JsonObject, revision: unknown, importedAt: string): JsonObject {
  return {
    annotationId: annotation["annotationId"],
    revision,
    highlighted: annotation["highlighted"],
    note: annotation["note"],
    updatedAt: annotation["updatedAt"],
    updatedBy: annotation["updatedBy"],
    importedAt,
  };
}

/**
 * Joins another computer's highlights into this Library's file by content: a branch that went on
 * from the other wins; two that changed apart keep this Library's as current (a new revision) and
 * the other's as the history version just before it, restorable from the reader.
 */
function joinAnnotationFiles(
  local: JsonObject,
  incoming: JsonObject,
  importedAt: string,
): { readonly file: JsonObject; readonly conflicts: number } {
  const annotations = new Map<string, JsonObject>();
  for (const entry of local["annotations"] as unknown[]) {
    if (isObject(entry)) annotations.set(String(entry["annotationId"]), entry);
  }
  const extraHistory: JsonObject[] = [];
  let conflicts = 0;
  for (const entry of incoming["annotations"] as unknown[]) {
    if (!isObject(entry)) continue;
    const id = String(entry["annotationId"]);
    const kept = annotations.get(id);
    const theirs = Number(entry["revision"]);
    const ours = Number(kept?.["revision"]);
    if (!kept) {
      annotations.set(id, entry);
    } else if (
      sameMark(kept, entry) &&
      JSON.stringify(kept["anchor"]) === JSON.stringify(entry["anchor"])
    ) {
      if (theirs > ours) annotations.set(id, entry);
    } else if (theirs > ours && continues(incoming, kept)) {
      annotations.set(id, entry);
    } else if (ours > theirs && continues(local, entry)) {
      continue;
    } else {
      const revision = Math.max(theirs, ours) + 1;
      extraHistory.push(historyEntry(entry, revision - 1, importedAt));
      annotations.set(id, { ...kept, revision });
      conflicts += 1;
    }
  }
  const history = new Map<string, unknown>();
  for (const entry of [
    ...(local["history"] as unknown[]),
    ...(incoming["history"] as unknown[]),
    ...extraHistory,
  ]) {
    if (!isObject(entry)) continue;
    const key = JSON.stringify([
      entry["annotationId"],
      entry["revision"],
      entry["highlighted"],
      entry["note"],
    ]);
    if (!history.has(key)) history.set(key, entry);
  }
  const paths = [
    ...new Set([
      ...((local["paths"] as unknown[]) ?? []),
      ...((incoming["paths"] as unknown[]) ?? []),
    ]),
  ].slice(0, 16);
  return {
    file: {
      ...local,
      paths,
      annotations: [...annotations.values()],
      history: [...history.values()],
    },
    conflicts,
  };
}

async function importAnnotations(
  library: ScientLibraryLocation,
  manifest: ScientProjectPackageManifest,
  state: ImportState,
  importedAt: string,
): Promise<{ readonly joined: number; readonly conflicts: number }> {
  const { annotationFile } = scientLibraryMoveInternals;
  let joined = 0;
  let conflicts = 0;
  for (const file of manifest.files) {
    const match = /^annotations\/([0-9a-f]{64})\.json$/u.exec(file.path);
    if (!match) continue;
    const sha256 = match[1]!;
    try {
      const incoming = annotationFile(
        JSON.parse((await readText(absolute(state.folder, file.path)))!),
        sha256,
      );
      if (!incoming) throw new Error("It is not a highlights file for that PDF.");
      await withScientLibraryLock(library.root, async () => {
        const relative = `${LIBRARY_ANNOTATIONS}/${sha256}.json`;
        const target = absolute(library.root, relative);
        const existingText = await readText(target);
        const existing = existingText ? annotationFile(JSON.parse(existingText), sha256) : null;
        if (existingText !== null && !existing) {
          throw new Error("This Library's highlights file for that PDF does not read.");
        }
        const next = existing
          ? joinAnnotationFiles(existing, incoming, importedAt)
          : { file: incoming, conflicts: 0 };
        await atomicWriteJson(target, next.file, MAX_JSON_BYTES);
        conflicts += next.conflicts;
        if (!existing) {
          state.receipt.annotationFiles.push({ path: relative, sha256: (await hashFile(target))! });
        }
      });
      joined += 1;
    } catch (error) {
      state.failed.push({ part: "annotations", item: file.path, message: message(error) });
    }
  }
  return { joined, conflicts };
}

/** Pins and note histories, in one hold of the project's pins lock. */
async function importProjectFiles(
  root: string,
  manifest: ScientProjectPackageManifest,
  state: ImportState,
  afterLock: (() => Promise<void>) | undefined,
): Promise<ScientProjectPinsJoin> {
  const pinsText = manifest.files.some((file) => file.path === "project/pins.json")
    ? await readText(absolute(state.folder, "project/pins.json"))
    : null;
  const noteHistories = [];
  for (const file of manifest.files) {
    if (!/^project\/note-history\/[^/]+\.json$/u.test(file.path)) continue;
    noteHistories.push(JSON.parse((await readText(absolute(state.folder, file.path)))!));
  }
  try {
    return await joinScientProjectPins({
      projectRoot: root,
      pins: pinsText === null ? [] : decodeScientProjectPinsText(pinsText),
      noteHistories,
      ...(afterLock ? { afterLock } : {}),
    });
  } catch (error) {
    state.failed.push({ part: "pins", item: "project/pins.json", message: message(error) });
    return {
      added: 0,
      addedKeys: [],
      joinedKeys: [],
      notesAdded: 0,
      notesKept: 0,
      historyAdded: 0,
      renamedKeys: [],
    };
  }
}

/**
 * A review this project lacks is added with its snapshot; a differing review is kept as another
 * version; an equal review takes a snapshot this project lacks, and a differing snapshot is kept
 * as another version too. Each review's files are checked before any is published, the decisions
 * last, and counted only once published.
 */
async function importReviews(
  root: string,
  manifest: ScientProjectPackageManifest,
  state: ImportState,
): Promise<{
  readonly added: number;
  readonly conflicts: number;
  readonly snapshotsAdded: number;
}> {
  let added = 0;
  let conflicts = 0;
  let snapshotsAdded = 0;
  await scientSourceStoreInternals.withOperationLock(`${root}:reviews-write`, async () => {
    const files = manifest.files.filter((file) => file.path.startsWith("project/reviews/"));
    const reviewIds = files.flatMap((file) => {
      const match = /^project\/reviews\/([^/]+)\.json$/u.exec(file.path);
      return match && !match[1]!.endsWith(".works") ? [match[1]!] : [];
    });
    for (const reviewId of reviewIds) {
      const published: Array<{ path: string; sha256: string }> = [];
      try {
        const reviewPath = `project/reviews/${reviewId}.json`;
        const own = await readText(absolute(root, `${REVIEWS}/${reviewId}.json`));
        const theirs = (await readText(absolute(state.folder, reviewPath)))!;
        const snapshots = files.filter((file) =>
          file.path.startsWith(`project/reviews/${reviewId}.works`),
        );
        const localSnapshots = await Promise.all(
          snapshots.map(async (file) =>
            hashFile(absolute(root, `${REVIEWS}/${file.path.slice("project/reviews/".length)}`)),
          ),
        );
        const snapshotsMissing = localSnapshots.every((hash) => hash === null);
        const snapshotsEqual = snapshots.every(
          (file, index) => localSnapshots[index] === file.sha256,
        );
        if (own === theirs && snapshotsEqual) continue;
        const keepAside = own !== null && !(own === theirs && snapshotsMissing);
        const tag = NodeCrypto.createHash("sha256")
          .update(theirs)
          .update(snapshots.map((file) => file.sha256).join(","))
          .digest("hex")
          .slice(0, 12);
        const targetOf = (path: string) => {
          const name = path.slice("project/reviews/".length);
          return keepAside
            ? `${REVIEW_CONFLICTS}/${reviewId}/${name.replace(reviewId, tag)}`
            : `${REVIEWS}/${name}`;
        };
        const review = files.find((file) => file.path === reviewPath)!;
        const order = own === theirs && !keepAside ? snapshots : [...snapshots, review];
        for (const file of order) {
          const target = targetOf(file.path);
          if ((await hashFile(absolute(root, target))) === file.sha256) continue;
          await publishCopy(absolute(state.folder, file.path), absolute(root, target), file.sha256);
          published.push({ path: target, sha256: file.sha256 });
        }
        state.receipt.reviewFiles.push(...published);
        if (keepAside) conflicts += 1;
        else if (own === null) added += 1;
        else snapshotsAdded += 1;
      } catch (error) {
        for (const file of published) {
          await NodeFSP.rm(absolute(root, file.path), { force: true });
        }
        state.failed.push({ part: "review", item: reviewId, message: message(error) });
      }
    }
  });
  return { added, conflicts, snapshotsAdded };
}

/** Collections with their ancestry, parents before children; a same-named sibling here is joined. */
async function importCollections(
  library: ScientLibraryLocation,
  mapped: ReadonlyMap<string, string>,
  actor: ScientSourceActor,
  state: ImportState,
): Promise<number> {
  const text = await readText(absolute(state.folder, "organization.json"));
  const document = text ? decodeOrganization(JSON.parse(text)) : { collections: [] };
  const entries = document.collections.map((collection, index) => ({
    ...collection,
    key: collection.collectionId ?? `name:${index}`,
    parentKey:
      collection.parentId ??
      (collection.parentName !== undefined ? `parent-name:${collection.parentName}` : undefined),
  }));
  const created = new Map<string, string>();
  const byName = new Map<string, string>();
  let count = 0;
  const pending = [...entries];
  while (pending.length > 0) {
    const index = pending.findIndex(
      (entry) =>
        entry.parentKey === undefined ||
        created.has(entry.parentKey) ||
        (entry.parentKey.startsWith("parent-name:") &&
          byName.has(entry.parentKey.slice("parent-name:".length))) ||
        !entries.some(
          (other) =>
            other.key === entry.parentKey ||
            (entry.parentKey!.startsWith("parent-name:") &&
              other.name === entry.parentKey!.slice("parent-name:".length)),
        ),
    );
    const entry = pending.splice(index === -1 ? 0 : index, 1)[0]!;
    const parentCollectionId =
      entry.parentKey === undefined
        ? undefined
        : (created.get(entry.parentKey) ??
          byName.get(entry.parentKey.slice("parent-name:".length)));
    const sourceIds = entry.projectSourceIds.flatMap((id) => {
      const sourceId = mapped.get(id);
      return sourceId ? [sourceId] : [];
    });
    if (sourceIds.length === 0 && !entries.some((other) => other.parentKey === entry.key)) {
      continue;
    }
    try {
      const change = await createScientSourceCollection({
        root: library,
        name: entry.name,
        sourceIds,
        ...(parentCollectionId ? { parentCollectionId } : {}),
        actor,
      });
      if (!change.collection) throw new Error(`The collection was not made (${change.outcome}).`);
      created.set(entry.key, change.collection.collectionId);
      if (entry.parentKey === undefined) byName.set(entry.name, change.collection.collectionId);
      if (change.outcome === "created") {
        state.receipt.collections.push(change.collection.collectionId);
        state.collectionVersions.push({
          collectionId: change.collection.collectionId,
          updatedAt: change.collection.updatedAt,
        });
      }
      count += 1;
    } catch (error) {
      state.failed.push({ part: "collection", item: entry.name, message: message(error) });
    }
  }
  return count;
}
export {
  undoScientProjectPackageImport,
  type ScientProjectPackageUndo,
} from "./projectPackageReceipt.ts";

export const scientProjectPackageInternals = { joinAnnotationFiles };
