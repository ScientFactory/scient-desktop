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
  readScientProjectSourceRejectedTargets,
  recordScientProjectSourceMappings,
  resolveScientProjectSources,
} from "./libraryInstanceMap.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import { scientLibraryMoveInternals } from "./libraryMove.ts";
import {
  decodeScientReviewSnapshotText,
  publishScientReviewSnapshotAt,
  readScientReviewSnapshotEntries,
  scientReviewNamedIds,
  type ScientReviewSnapshotPlace,
  type ScientReviewWork,
} from "./libraryReviews.ts";
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
  type ScientProjectPinsJoin,
} from "./projectPins.ts";
import {
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
        state:
          graver || local.editorialStatus === undefined
            ? incoming.editorialStatus!.state
            : local.editorialStatus.state,
        notices: [...localNotices, ...added].slice(0, 64),
        carriedAt: at,
      }
    : (local.editorialStatus ?? null);
  return {
    verification: verification ?? { state: "unchecked" },
    editorialStatus,
  };
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
  /** Each created record's revision and collection's version, from the import's own writes. */
  readonly created: {
    readonly sources: Map<string, number>;
    readonly collections: Array<{ collectionId: string; updatedAt: string }>;
  };
  /** Existing records and collections the import joined, which another import's Undo keeps. */
  readonly joinedSourceIds: Set<string>;
  readonly joinedCollectionIds: Set<string>;
  /** What the import put into what was already here; its Undo leaves it. */
  readonly evidence: string[];
  readonly counts: { matched: number; pdfsPresent: number };
  readonly failed: ScientProjectPackageFailure[];
}

interface ImportContext {
  readonly library: ScientLibraryLocation;
  readonly instanceId: string;
  readonly importId: string;
  readonly importedAt: string;
  readonly actor: ScientSourceActor;
  readonly state: ImportState;
  readonly mapped: Map<string, string>;
  readonly pdfFiles: ReadonlySet<string>;
  readonly afterTargetCheck: ((sourceId: string) => Promise<void>) | undefined;
}

/** The record a packaged source joins, or a new one; never one that rule or a decision refuses. */
async function packageTarget(
  context: ImportContext,
  projectSourceId: string,
  record: ScientSourceRecord,
  proposals: ReadonlyArray<string | null>,
): Promise<
  { readonly target: ScientSourceRecord; readonly created: boolean } | { readonly failure: string }
> {
  const { library } = context;
  const refused = new Set(
    await readScientProjectSourceRejectedTargets({
      library,
      instanceId: context.instanceId,
      projectSourceId,
    }),
  );
  for (const proposed of proposals) {
    if (proposed === null || refused.has(proposed)) continue;
    if (!(await readScientSourceRecord(library, proposed))) continue;
    const target = await packageTargetHolds(library, record, proposed);
    if (target) return { target, created: false };
    refused.add(proposed);
  }
  // Intake judges with the package record's own ID and never offers a refused record again.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const imported = await importScientSource({
      root: library,
      operationId: `package_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      candidate: candidateFrom(
        record,
        refused.size > 0 ? `${projectSourceId}:${context.importId}` : projectSourceId,
      ),
      actor: context.actor,
      intake: "file",
      // Title likeness alone adds a new source; the shared rule decides any other match.
      allowPossibleMetadataMatch: true,
      incomingSourceId: record.sourceId,
      hydratedFromProjectSourceId: projectSourceId,
      refusedSourceIds: [...refused],
      ...carried(record, context.importedAt),
    });
    if (imported.record) return { target: imported.record, created: true };
    const reused =
      imported.duplicate.kind === "new" ? undefined : imported.duplicate.matchingSourceIds[0];
    if (!reused) return { failure: imported.duplicate.reason };
    if (refused.has(reused)) return { failure: "This project keeps that paper separate." };
    const target = await packageTargetHolds(library, record, reused);
    if (target) return { target, created: false };
    refused.add(reused);
  }
  return { failure: "Several papers here match it but are other works; it was not imported." };
}

const CHANGED_WHILE_IMPORTED =
  "It changed here while it was being imported, so it was left as it is; import the package again.";

async function preparePackagedPdfs(context: ImportContext, record: ScientSourceRecord) {
  const prepared = new Map<
    string,
    Awaited<ReturnType<typeof scientSourceStoreInternals.preparePdfAttachment>>
  >();
  for (const attachment of record.attachments) {
    const item = `pdfs/${attachment.sha256}.pdf`;
    if (!context.pdfFiles.has(item) || prepared.has(attachment.sha256)) continue;
    try {
      if (!(await insidePackage(context.state.folder, item)))
        throw new Error(`${item} leaves the package.`);
      prepared.set(
        attachment.sha256,
        await scientSourceStoreInternals.preparePdfAttachment({
          root: context.library,
          pdfPath: absolute(context.state.folder, item),
          fileName: attachment.fileName,
          expectedPdf: { sha256: attachment.sha256, byteLength: attachment.byteLength },
          ...(attachment.retrieval ? { retrieval: attachment.retrieval } : {}),
        }),
      );
    } catch (error) {
      context.state.failed.push({ part: "pdf", item, message: message(error) });
    }
  }
  return prepared;
}

/**
 * One packaged source, in one hold of the Library lock: its target decided, then every write
 * (notices, abstract, PDFs, the mapping) made on that decision's revision. A write that finds the
 * target changed stops this source; nothing is mapped or attached on an unchecked revision.
 */
async function placePackagedSource(
  context: ImportContext,
  prepared: Awaited<ReturnType<typeof preparePackagedPdfs>>,
  {
    projectSourceId,
    record,
  }: { readonly projectSourceId: string; readonly record: ScientSourceRecord },
  proposals: ReadonlyArray<string | null>,
): Promise<void> {
  const { library, state, importedAt } = context;
  const fail = (message: string) => {
    state.failed.push({ part: "source", item: projectSourceId, message });
  };
  const decided = await packageTarget(context, projectSourceId, record, proposals);
  if ("failure" in decided) return fail(decided.failure);
  let target = decided.target;
  const { created } = decided;
  const sourceId = target.sourceId;
  if (created) {
    state.receipt.sources.push(sourceId);
    state.created.sources.set(sourceId, target.revision);
  }
  await context.afterTargetCheck?.(sourceId);
  if (!created) {
    const checked = scientPackageCheckJoin(target, record, importedAt);
    if (checked) {
      const result = await recordScientSourceCheck({
        root: library,
        sourceId,
        expectedRevision: target.revision,
        verification: checked.verification,
        editorialStatus: checked.editorialStatus,
        actor: context.actor,
      });
      if (result.outcome === "stale") return fail(CHANGED_WHILE_IMPORTED);
      if (result.outcome === "updated") state.evidence.push(`notices on source ${sourceId}`);
      target = result.record;
    }
    // An abstract only the package knows comes along, with where it came from.
    if (target.abstract === null && record.abstract !== null) {
      const provenance = record.fieldProvenance.filter((entry) => entry.field === "abstract");
      const edited = await updateScientSourceMetadata({
        root: library,
        sourceId,
        expectedRevision: target.revision,
        metadata: { ...editableMetadataFromRecord(target), abstract: record.abstract },
        ...(provenance.length > 0 ? { fieldProvenance: provenance } : {}),
        actor: context.actor,
      }).catch(() => null);
      if (edited?.outcome === "stale") return fail(CHANGED_WHILE_IMPORTED);
      if (edited?.outcome === "updated") {
        target = edited.record;
        state.evidence.push(`abstract on source ${sourceId}`);
      }
    }
  }
  for (const attachment of record.attachments) {
    if (target.attachments.some((entry) => entry.sha256 === attachment.sha256)) {
      state.counts.pdfsPresent += 1;
      continue;
    }
    const item = `pdfs/${attachment.sha256}.pdf`;
    const attach = prepared.get(attachment.sha256);
    if (!attach) continue;
    const attached = await attach({
      sourceId,
      expectedRevision: target.revision,
      actor: context.actor,
    }).catch((error: unknown) => {
      state.failed.push({ part: "pdf", item, message: message(error) });
      return null;
    });
    if (!attached) continue;
    if (attached.outcome === "stale") return fail(CHANGED_WHILE_IMPORTED);
    target = attached.record;
    const added = target.attachments.find((entry) => entry.sha256 === attachment.sha256);
    if (!added) {
      state.failed.push({ part: "pdf", item, message: attached.outcome });
    } else if (attached.outcome === "attached") {
      state.receipt.pdfs.push({ sourceId, attachmentId: added.attachmentId });
      if (created) state.created.sources.set(sourceId, target.revision);
      else state.evidence.push(`PDF ${added.attachmentId} on source ${sourceId}`);
    }
  }
  await recordScientProjectSourceMappings({
    library,
    instanceId: context.instanceId,
    mappings: [{ projectSourceId, sourceId }],
  });
  context.mapped.set(projectSourceId, sourceId);
  if (!created) {
    state.counts.matched += 1;
    state.joinedSourceIds.add(sourceId);
  }
}

/**
 * Brings a checked package in as evidence from another computer: a source joins a record only by
 * the shared identity rule (never title likeness), else it is added; highlights, note histories
 * and reviews join without overwriting anything. A receipt lists what was created, for Undo, and
 * what was joined, which stays.
 */
export async function importScientProjectPackage(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly folder: string;
  readonly actor: ScientSourceActor;
  /** Test-only: runs once the project's pins lock is held. */
  readonly afterPinsLock?: () => Promise<void>;
  /** Test-only: runs once a source's target is decided, before anything is written to it. */
  readonly afterTargetCheck?: (sourceId: string) => Promise<void>;
}): Promise<ScientProjectPackageImport> {
  const root = await NodeFSP.realpath(input.projectRoot);
  const { projectId } = await readScientProjectIdentity(root);
  const folder = await NodeFSP.realpath(input.folder).catch(() => input.folder);
  if (!(await insidePackage(folder, MANIFEST_FILE))) return { outcome: "not-a-package" };
  const manifest = await readScientProjectPackageManifest(folder);
  if (!manifest) return { outcome: "not-a-package" };
  const changed: string[] = [];
  for (const file of manifest.files) {
    if (
      !safePackagePath(file.path) ||
      !(await insidePackage(folder, file.path)) ||
      (await hashFile(absolute(folder, file.path))) !== file.sha256
    ) {
      changed.push(file.path);
    }
  }
  if (changed.length > 0) return { outcome: "package-changed", files: changed };
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
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  const pdfFiles = new Set<string>();
  const unavailable = [...manifest.unavailable];
  for (const { projectSourceId, record } of packaged) {
    for (const attachment of record.attachments) {
      const item = `pdfs/${attachment.sha256}.pdf`;
      const file = listed.get(item);
      if (!file) {
        if (
          !unavailable.some(
            (entry) =>
              entry.projectSourceId === projectSourceId && entry.sha256 === attachment.sha256,
          )
        ) {
          unavailable.push({
            projectSourceId,
            kind: "pdf",
            sha256: attachment.sha256,
            fileName: attachment.fileName,
          });
        }
      } else if (
        file.sha256 !== attachment.sha256 ||
        file.bytes !== attachment.byteLength ||
        !(await insidePackage(folder, item))
      ) {
        changed.push(item);
      } else {
        pdfFiles.add(item);
      }
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
    created: { sources: new Map(), collections: [] },
    joinedSourceIds: new Set(),
    joinedCollectionIds: new Set(),
    evidence: [],
    counts: { matched: 0, pdfsPresent: 0 },
    failed: [],
  };
  const context: ImportContext = {
    library,
    instanceId,
    importId,
    importedAt,
    actor: input.actor,
    state,
    mapped: new Map(),
    pdfFiles,
    afterTargetCheck: input.afterTargetCheck,
  };

  const resolutions = await resolveScientProjectSources({
    library,
    projectRoot: root,
    mode: "read",
    sources: packaged.map(({ projectSourceId, record }) => ({ projectSourceId, work: record })),
  });
  const aliases = await readScientLibraryAliases(library);
  for (const [index, source] of packaged.entries()) {
    const resolution = resolutions[index]!;
    // Title likeness is no identity here; every proposed target is checked again under the lock.
    const proposals = [
      resolveScientLibraryAlias(aliases, source.record.sourceId),
      resolution.kind === "resolved" && resolution.by !== "metadata" ? resolution.sourceId : null,
    ];
    try {
      const prepared = await preparePackagedPdfs(context, source.record);
      await withScientLibraryLock(library.root, () =>
        placePackagedSource(context, prepared, source, proposals),
      );
    } catch (error) {
      state.failed.push({ part: "source", item: source.projectSourceId, message: message(error) });
    }
  }

  const annotations = await importAnnotations(library, manifest, state, importedAt);
  const pins = await importProjectFiles(root, manifest, state, input.afterPinsLock);
  const reviews = await importReviews(root, manifest, state);
  const collections = manifest.files.some((file) => file.path === "organization.json")
    ? await importCollections(library, context.mapped, input.actor, state)
    : 0;
  if (pins.historyAdded > 0) {
    state.evidence.push(`${pins.historyAdded} earlier project-note versions in the note history`);
  }
  if (pins.notesKept > 0) {
    state.evidence.push(`${pins.notesKept} other project notes in the note history`);
  }
  const { matched, pdfsPresent } = state.counts;
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
      created: {
        sources: [...state.created.sources].map(([sourceId, revision]) => ({
          sourceId,
          revision,
        })),
        pins: pins.written.pins,
        notes: pins.written.notes,
        collections: state.created.collections,
      },
    },
    joined: {
      sourceIds: [...state.joinedSourceIds],
      pinKeys: [...pins.joinedKeys],
      collectionIds: [...state.joinedCollectionIds],
      evidence: state.evidence,
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
    pdfs: { added: state.receipt.pdfs.length, present: pdfsPresent },
    annotations: annotations.joined,
    annotationConflicts: annotations.conflicts,
    pins,
    reviews,
    collections,
    unavailable,
    failed: state.failed,
  };
}

/** Whether a package file, links resolved, stays inside the package folder (or is missing). */
async function insidePackage(folder: string, path: string): Promise<boolean> {
  const real = await NodeFSP.realpath(absolute(folder, path)).catch(() => null);
  if (real === null) return true;
  const relative = NodePath.relative(folder, real);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
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
        } else {
          state.evidence.push(`highlights ${relative}`);
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
      written: { pins: [], notes: [] },
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
        if (keepAside) {
          // Published as every snapshot is: one file, or shards once one would be too big.
          const place = {
            projectRoot: root,
            directory: `${REVIEW_CONFLICTS}/${reviewId}`,
            name: tag,
            reviewId,
          };
          const entries = await keptSnapshotEntries(
            root,
            state.folder,
            reviewId,
            theirs,
            snapshots,
          );
          if (await publishScientReviewSnapshotAt(place, entries)) {
            published.push(...(await snapshotFiles(place)));
          }
        }
        const order =
          own === theirs && !keepAside ? snapshots : keepAside ? [review] : [...snapshots, review];
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

/**
 * The package's snapshot of a review: its file and its shards (shard entries win, as readers do),
 * plus this project's entries for records the package's review names that its snapshot lacks, so
 * choosing that version loses none.
 */
async function keptSnapshotEntries(
  root: string,
  folder: string,
  reviewId: string,
  reviewText: string,
  snapshots: ReadonlyArray<{ readonly path: string }>,
): Promise<ReadonlyMap<string, ScientReviewWork>> {
  const entries = new Map<string, ScientReviewWork>();
  const ordered = snapshots.toSorted(
    (left, right) => Number(left.path.includes(".works/")) - Number(right.path.includes(".works/")),
  );
  for (const file of ordered) {
    const decoded = decodeScientReviewSnapshotText(
      (await readText(absolute(folder, file.path)))!,
      reviewId,
    );
    if (!decoded) throw new Error(`${file.path} is not this review's snapshot.`);
    for (const [sourceId, work] of decoded) entries.set(sourceId, work);
  }
  const local = await readScientReviewSnapshotEntries(root, reviewId);
  for (const sourceId of scientReviewNamedIds(decodeReview(JSON.parse(reviewText)))) {
    const work = local.get(sourceId);
    if (!entries.has(sourceId) && work) entries.set(sourceId, work);
  }
  return entries;
}

/** The files a snapshot at `place` is now, project-relative, with their bytes' hashes. */
async function snapshotFiles(
  place: ScientReviewSnapshotPlace,
): Promise<Array<{ path: string; sha256: string }>> {
  const single = `${place.directory}/${place.name}.works.json`;
  const shards = `${place.directory}/${place.name}.works`;
  const names = await NodeFSP.readdir(absolute(place.projectRoot, shards)).catch(() => []);
  const files = [];
  for (const path of [single, ...names.toSorted().map((name) => `${shards}/${name}`)]) {
    const sha256 = await hashFile(absolute(place.projectRoot, path));
    if (sha256 !== null) files.push({ path, sha256 });
  }
  return files;
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
        state.created.collections.push({
          collectionId: change.collection.collectionId,
          updatedAt: change.collection.updatedAt,
        });
      } else {
        state.joinedCollectionIds.add(change.collection.collectionId);
        if ("addedSourceIds" in change && change.addedSourceIds.length > 0) {
          state.evidence.push(
            `${change.addedSourceIds.length} papers in collection ${change.collection.collectionId}`,
          );
        }
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
  listScientProjectPackageImports,
  type ScientProjectPackageUndo,
} from "./projectPackageReceipt.ts";

export const scientProjectPackageInternals = { joinAnnotationFiles };
