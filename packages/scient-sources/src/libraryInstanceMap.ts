// @effect-diagnostics nodeBuiltinImport:off -- The instance map is a file in the personal library.
// @effect-diagnostics globalDate:off -- Library files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { assessSourceMetadataDuplicate, workLevelIdentifierKey } from "./duplicates.ts";
import { readLibraryAliasesAt, resolveScientLibraryAlias } from "./libraryAliases.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  listScientLibraryInstances,
  readScientLibraryManifest,
  registerScientLibraryInstance,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import {
  ScientSourceType,
  type ScientSourceActor,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceIdentifier,
  type ScientSourceRecord,
} from "./model.ts";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceTrashEntries,
  scientSourceIdFor,
} from "./store.ts";
import { assertSafeIdentifier, atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const SCIENT_LIBRARY_PROJECTS_DIRECTORY = "projects";
const MAX_INSTANCE_MAP_BYTES = 16 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

const ResolutionStep = Schema.Literals([
  "instance-map",
  "same-id",
  "identifier",
  "metadata",
  "hydrated",
  "moved",
]);
type ResolutionStep = typeof ResolutionStep.Type;

const InstanceMapEntry = Schema.Struct({
  projectSourceId: NonEmptyString,
  /** The library ID it resolved to then; aliases are followed on every read, so Undo still works. */
  sourceId: NonEmptyString,
  resolvedBy: ResolutionStep,
  resolvedAt: NonEmptyString,
});
type InstanceMapEntry = typeof InstanceMapEntry.Type;

const InstanceMapFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  instanceId: NonEmptyString,
  sources: Schema.Array(InstanceMapEntry),
});

/** What a project keeps about a work: a pin's `work`, or a review's record snapshot. */
export interface ScientProjectSourceWork {
  readonly type: string;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedYear: number | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly containerTitle: string | null;
}

export interface ScientProjectSourceRequest {
  readonly projectSourceId: string;
  readonly work: ScientProjectSourceWork | null;
}

export type ScientProjectSourceResolution =
  | {
      readonly kind: "resolved";
      readonly projectSourceId: string;
      readonly sourceId: string;
      readonly by: ResolutionStep;
    }
  | {
      readonly kind: "unresolved";
      readonly projectSourceId: string;
      /** `removed`: the mapped library record is gone and nothing else matched; never hydrated. */
      readonly reason: "no-match" | "ambiguous" | "removed";
      readonly candidateIds: ReadonlyArray<string>;
    };

export interface ScientProjectSourceResolveInput {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly sources: ReadonlyArray<ScientProjectSourceRequest>;
  /** `read` writes nothing at all; `write` records new resolutions under the library lock. */
  readonly mode: "read" | "write";
  /** In `write` mode, creates a library record from the snapshot of each unmatched source. */
  readonly hydrate?: {
    readonly actor: ScientSourceActor;
    /** Preferred keys for hydrated records, by project source ID. */
    readonly citationKeys?: ReadonlyMap<string, string>;
  };
}

const isScientSourceType = Schema.is(ScientSourceType);

/** A snapshot's type, or `other` for one a newer Scient knows and this one does not. */
export function scientSourceTypeFromSnapshot(type: string): ScientSourceType {
  return isScientSourceType(type) ? type : "other";
}

function instanceMapPath(root: string, instanceId: string): string {
  assertSafeIdentifier(instanceId, "Instance ID");
  return NodePath.join(root, SCIENT_LIBRARY_PROJECTS_DIRECTORY, `${instanceId}.json`);
}

async function readInstanceMap(
  root: string,
  instanceId: string,
): Promise<Map<string, InstanceMapEntry>> {
  const filePath = instanceMapPath(root, instanceId);
  const state = await snapshot(filePath);
  if (state === "missing") return new Map();
  if (state !== "file") throw new Error("The project instance map is not a safe regular file.");
  const file = await readBoundedJson(filePath, MAX_INSTANCE_MAP_BYTES, InstanceMapFile);
  if (file.instanceId !== instanceId) throw new Error("The project instance map is inconsistent.");
  return new Map(file.sources.map((entry) => [entry.projectSourceId, entry]));
}

async function writeInstanceMap(
  root: string,
  instanceId: string,
  entries: ReadonlyMap<string, InstanceMapEntry>,
): Promise<void> {
  await atomicWriteJson(
    instanceMapPath(root, instanceId),
    {
      formatVersion: 1,
      instanceId,
      sources: [...entries.values()]
        .toSorted((left, right) => (left.projectSourceId < right.projectSourceId ? -1 : 1))
        .map((entry) => ({
          projectSourceId: entry.projectSourceId,
          sourceId: entry.sourceId,
          resolvedBy: entry.resolvedBy,
          resolvedAt: entry.resolvedAt,
        })),
    },
    MAX_INSTANCE_MAP_BYTES,
  );
}

function workLevelKeys(identifiers: ReadonlyArray<ScientSourceIdentifier>): Set<string> {
  return new Set(
    identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key ? [key] : [];
    }),
  );
}

/** Identifier first, then title, lead author and year; one match resolves, more stay ambiguous. */
function matchWork(
  work: ScientProjectSourceWork,
  records: ReadonlyArray<ScientSourceRecord>,
): { readonly by: "identifier" | "metadata"; readonly ids: ReadonlyArray<string> } | null {
  const own = workLevelKeys(work.identifiers);
  // Two works that name different DOIs (or PMIDs, …) are never the same work by title alone.
  const compatible = records.filter((record) => {
    const theirs = workLevelKeys(record.identifiers);
    return own.size === 0 || theirs.size === 0 || [...own].some((key) => theirs.has(key));
  });
  const assessment = assessSourceMetadataDuplicate({
    source: { ...work, identifiers: [...work.identifiers], creators: [...work.creators] },
    existing: compatible,
  });
  if (assessment.kind === "same-identifier") {
    return { by: "identifier", ids: assessment.matchingSourceIds };
  }
  if (assessment.kind === "possible-metadata-match") {
    return { by: "metadata", ids: assessment.matchingSourceIds };
  }
  return null;
}

function hydrationSourceKey(projectSourceId: string): string {
  return `project-source:${projectSourceId}`;
}

function hydrationCandidate(
  request: ScientProjectSourceRequest & { readonly work: ScientProjectSourceWork },
  citationKey: string | undefined,
): ScientSourceCandidate {
  const { work } = request;
  const filled = (
    [
      ["title", work.title !== null],
      ["creators", work.creators.length > 0],
      ["issuedYear", work.issuedYear !== null],
      ["identifiers", work.identifiers.length > 0],
      ["containerTitle", work.containerTitle !== null],
    ] as const
  ).filter(([, present]) => present);
  return {
    sourceKey: hydrationSourceKey(request.projectSourceId),
    ...(citationKey ? { citationKey } : {}),
    type: scientSourceTypeFromSnapshot(work.type),
    customType: null,
    title: work.title,
    creators: work.creators,
    issuedRaw: work.issuedYear === null ? null : String(work.issuedYear),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers,
    abstract: null,
    containerTitle: work.containerTitle,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: filled.map(([field]) => ({
      field,
      origin: "file",
      sourceField: `project-file:${field}`,
    })),
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

async function projectInstanceId(
  library: ScientLibraryLocation,
  projectRoot: string,
  mode: "read" | "write",
): Promise<string | null> {
  const { projectId } = await readScientProjectIdentity(projectRoot);
  if (mode === "write") {
    return (await registerScientLibraryInstance({ library, projectId, projectRoot })).instanceId;
  }
  const path = await NodeFSP.realpath(projectRoot);
  const instances = await listScientLibraryInstances(library);
  return (
    instances.find((instance) => instance.projectId === projectId && instance.path === path)
      ?.instanceId ?? null
  );
}

async function resolveAt(
  root: string,
  input: ScientProjectSourceResolveInput,
): Promise<ReadonlyArray<ScientProjectSourceResolution>> {
  const library = input.library;
  const instanceId = await projectInstanceId(library, input.projectRoot, input.mode);
  const map = instanceId ? await readInstanceMap(root, instanceId) : new Map();
  const aliases = await readLibraryAliasesAt(root);
  const records = [...(await listScientSourceRecords(library))];
  const live = new Set(records.map((record) => record.sourceId));
  const liveTarget = (sourceId: string) => {
    const target = resolveScientLibraryAlias(aliases, sourceId);
    return live.has(target) ? target : null;
  };
  const resolvedAt = new Date().toISOString();
  const recorded = new Map(map);
  let mapChanged = false;
  const record = (projectSourceId: string, sourceId: string, by: ResolutionStep) => {
    recorded.set(projectSourceId, { projectSourceId, sourceId, resolvedBy: by, resolvedAt });
    mapChanged = true;
  };

  // The map can be lost, or a crash can precede its write; the trash still says what was removed.
  let trash:
    | Promise<{ readonly libraryId: string; readonly removed: ScientSourceRecord[] }>
    | undefined;
  const wasRemoved = async ({ projectSourceId, work }: ScientProjectSourceRequest) => {
    trash ??= Promise.all([
      readScientLibraryManifest(root),
      readScientSourceTrashEntries(library),
    ]).then(([{ libraryId }, entries]) => ({
      libraryId,
      // A merge moves the losing record to the trash; that is not a removal while the winner lives.
      removed: entries
        .filter((entry) => !entry.mergedInto || liveTarget(entry.sourceId) === null)
        .map((entry) => entry.record),
    }));
    const { libraryId, removed } = await trash;
    const ids = new Set([
      projectSourceId,
      resolveScientLibraryAlias(aliases, projectSourceId),
      scientSourceIdFor(libraryId, hydrationSourceKey(projectSourceId)),
    ]);
    return (
      removed.some((record) => ids.has(record.sourceId)) ||
      (work !== null && matchWork(work, removed) !== null)
    );
  };

  const results: ScientProjectSourceResolution[] = [];
  for (const request of input.sources) {
    const { projectSourceId } = request;
    const mapped = recorded.get(projectSourceId);
    const mappedTarget = mapped ? liveTarget(mapped.sourceId) : null;
    if (mappedTarget) {
      results.push({
        kind: "resolved",
        projectSourceId,
        sourceId: mappedTarget,
        by: "instance-map",
      });
      continue;
    }
    const sameId = liveTarget(projectSourceId);
    if (sameId) {
      record(projectSourceId, projectSourceId, "same-id");
      results.push({ kind: "resolved", projectSourceId, sourceId: sameId, by: "same-id" });
      continue;
    }
    const match = request.work ? matchWork(request.work, records) : null;
    if (match && match.ids.length === 1) {
      const sourceId = match.ids[0]!;
      record(projectSourceId, sourceId, match.by);
      results.push({ kind: "resolved", projectSourceId, sourceId, by: match.by });
      continue;
    }
    if (match) {
      results.push({
        kind: "unresolved",
        projectSourceId,
        reason: "ambiguous",
        candidateIds: match.ids,
      });
      continue;
    }
    if (mapped || (await wasRemoved(request))) {
      results.push({ kind: "unresolved", projectSourceId, reason: "removed", candidateIds: [] });
      continue;
    }
    if (input.mode === "write" && input.hydrate && request.work) {
      const hydrated = await importScientSource({
        root: library,
        operationId: `hydrate_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        candidate: hydrationCandidate(
          { projectSourceId, work: request.work },
          input.hydrate.citationKeys?.get(projectSourceId),
        ),
        allowPossibleMetadataMatch: true,
        actor: input.hydrate.actor,
        intake: "file",
      });
      const sourceId =
        hydrated.record?.sourceId ??
        (hydrated.duplicate.matchingSourceIds.length === 1
          ? hydrated.duplicate.matchingSourceIds[0]
          : undefined);
      if (sourceId) {
        // Later sources in this call must match the new record instead of hydrating a twin.
        if (hydrated.record) {
          records.push(hydrated.record);
          live.add(sourceId);
        }
        record(projectSourceId, sourceId, "hydrated");
        results.push({ kind: "resolved", projectSourceId, sourceId, by: "hydrated" });
        continue;
      }
    }
    results.push({ kind: "unresolved", projectSourceId, reason: "no-match", candidateIds: [] });
  }

  if (input.mode === "write" && instanceId && mapChanged) {
    await writeInstanceMap(root, instanceId, recorded);
  }
  return results;
}

/**
 * Records where the move put each project source ID, for the copies the resolver cannot find on
 * its own (a diverged copy imported under a new ID). Caller holds the library lock.
 */
export async function recordScientProjectSourceMappings(input: {
  readonly library: ScientLibraryLocation;
  readonly instanceId: string;
  readonly mappings: ReadonlyArray<{ readonly projectSourceId: string; readonly sourceId: string }>;
}): Promise<void> {
  const root = await NodeFSP.realpath(input.library.root);
  const map = await readInstanceMap(root, input.instanceId);
  const resolvedAt = new Date().toISOString();
  let changed = false;
  for (const { projectSourceId, sourceId } of input.mappings) {
    if (map.get(projectSourceId)?.sourceId === sourceId) continue;
    map.set(projectSourceId, { projectSourceId, sourceId, resolvedBy: "moved", resolvedAt });
    changed = true;
  }
  if (changed) await writeInstanceMap(root, input.instanceId, map);
}

/**
 * Resolves project source IDs in the design's order: the instance map, the same ID through
 * aliases, then identifier and title/author/year against the snapshot. Pins, reviews, annotation
 * hints and links all resolve here.
 */
export async function resolveScientProjectSources(
  input: ScientProjectSourceResolveInput,
): Promise<ReadonlyArray<ScientProjectSourceResolution>> {
  const root = await NodeFSP.realpath(input.library.root);
  if (input.mode === "read") return resolveAt(root, input);
  return withScientLibraryLock(root, () => resolveAt(root, input));
}
