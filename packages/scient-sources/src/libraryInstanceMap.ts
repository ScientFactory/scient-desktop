// @effect-diagnostics nodeBuiltinImport:off -- The instance map is a file in the personal library.
// @effect-diagnostics globalDate:off -- Library files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { assessSourceMetadataDuplicate } from "./duplicates.ts";
import { readLibraryAliasesAt, resolveScientLibraryAlias } from "./libraryAliases.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import {
  listScientLibraryInstances,
  readScientLibraryManifest,
  registerScientLibraryInstance,
  type ScientLibraryLocation,
} from "./libraryRoot.ts";
import {
  ScientSourceActor,
  ScientSourceType,
  type ScientSourceCandidate,
  type ScientSourceIdentifier,
  type ScientSourceRecord,
} from "./model.ts";
import type { ScientPinCitationWork } from "./pinCitation.ts";
import {
  importScientSource,
  listScientSourceRecords,
  readScientSourceTombstones,
  readScientSourceTrashEntries,
  scientSourceIdFor,
} from "./store.ts";
import { scientLibraryIdentityProblem, workLevelIdentifierKey } from "./sourceIdentity.ts";
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
  /** A person's or agent's deliberate link of a pin the automatic steps would not resolve. */
  "linked",
]);
type ResolutionStep = typeof ResolutionStep.Type;

const InstanceMapEntryFields = {
  projectSourceId: NonEmptyString,
  /** The library ID it resolved to then; aliases are followed on every read, so Undo still works. */
  sourceId: NonEmptyString,
  resolvedBy: ResolutionStep,
  resolvedAt: NonEmptyString,
};
const InstanceMapEntry = Schema.Struct({
  ...InstanceMapEntryFields,
  /** Who linked it, for `linked`. */
  linkedBy: Schema.optionalKey(ScientSourceActor),
  /** What a link replaced, so its Undo puts that back. */
  replaced: Schema.optionalKey(Schema.Struct(InstanceMapEntryFields)),
});
type InstanceMapEntry = typeof InstanceMapEntry.Type;

/** A decision that a pin is not the Library sources it was compared with. */
const KeptSeparate = Schema.Struct({
  projectSourceId: NonEmptyString,
  sourceIds: Schema.Array(NonEmptyString),
  decidedAt: NonEmptyString,
  decidedBy: ScientSourceActor,
});
type KeptSeparate = typeof KeptSeparate.Type;

const InstanceMapFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  instanceId: NonEmptyString,
  sources: Schema.Array(InstanceMapEntry),
  keptSeparate: Schema.optionalKey(Schema.Array(KeptSeparate)),
});

/** What a project keeps about a work: a pin's `work`, or a review's record snapshot. */
/** A pin's or review's snapshot; a pin's also carries the other citation inputs it knows. */
export type ScientProjectSourceWork = ScientPinCitationWork;

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
      /**
       * `removed`: the mapped library record is in the trash or deleted for good and nothing else
       * matched; never hydrated. Its `candidateIds` name the removed records.
       */
      /** `contradicted`: only matches that disagree with the snapshot; never hydrated. */
      readonly reason: "no-match" | "ambiguous" | "contradicted" | "removed";
      readonly candidateIds: ReadonlyArray<string>;
      /** Someone decided this pin is none of these candidates. */
      readonly keptSeparate?: true;
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

interface InstanceMap {
  readonly entries: Map<string, InstanceMapEntry>;
  readonly keptSeparate: Map<string, KeptSeparate>;
}

async function readInstanceMapFile(root: string, instanceId: string): Promise<InstanceMap> {
  const filePath = instanceMapPath(root, instanceId);
  const state = await snapshot(filePath);
  if (state === "missing") return { entries: new Map(), keptSeparate: new Map() };
  if (state !== "file") throw new Error("The project instance map is not a safe regular file.");
  const file = await readBoundedJson(filePath, MAX_INSTANCE_MAP_BYTES, InstanceMapFile);
  if (file.instanceId !== instanceId) throw new Error("The project instance map is inconsistent.");
  return {
    entries: new Map(file.sources.map((entry) => [entry.projectSourceId, entry])),
    keptSeparate: new Map(
      (file.keptSeparate ?? []).map((decision) => [decision.projectSourceId, decision]),
    ),
  };
}

async function readInstanceMap(
  root: string,
  instanceId: string,
): Promise<Map<string, InstanceMapEntry>> {
  return (await readInstanceMapFile(root, instanceId)).entries;
}

const byProjectSourceId = <A extends { readonly projectSourceId: string }>(
  values: Iterable<A>,
): Array<A> =>
  [...values].toSorted((left, right) => (left.projectSourceId < right.projectSourceId ? -1 : 1));

async function writeInstanceMap(
  root: string,
  instanceId: string,
  entries: ReadonlyMap<string, InstanceMapEntry>,
  keptSeparate?: ReadonlyMap<string, KeptSeparate>,
): Promise<void> {
  const separate = keptSeparate ?? (await readInstanceMapFile(root, instanceId)).keptSeparate;
  await atomicWriteJson(
    instanceMapPath(root, instanceId),
    {
      formatVersion: 1,
      instanceId,
      sources: byProjectSourceId(entries.values()).map((entry) => ({
        projectSourceId: entry.projectSourceId,
        sourceId: entry.sourceId,
        resolvedBy: entry.resolvedBy,
        resolvedAt: entry.resolvedAt,
        ...(entry.linkedBy ? { linkedBy: entry.linkedBy } : {}),
        ...(entry.replaced ? { replaced: entry.replaced } : {}),
      })),
      ...(separate.size > 0 ? { keptSeparate: byProjectSourceId(separate.values()) } : {}),
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

/**
 * Identifier first, then title, lead author and year; one corroborated match resolves, more stay
 * ambiguous. Matches that do not corroborate the snapshot (`scientLibraryIdentityProblem`: titles,
 * known types, arXiv versions, conflicting identifiers) never resolve; with none corroborated they
 * are `contradicted`.
 */
function matchWork(
  work: ScientProjectSourceWork,
  records: ReadonlyArray<ScientSourceRecord>,
): {
  readonly by: "identifier" | "metadata" | "contradicted";
  readonly ids: ReadonlyArray<string>;
} | null {
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
  const by =
    assessment.kind === "same-identifier"
      ? "identifier"
      : assessment.kind === "possible-metadata-match"
        ? "metadata"
        : null;
  if (!by) return null;
  const byId = new Map(compatible.map((record) => [record.sourceId, record]));
  const corroborated = assessment.matchingSourceIds.filter(
    (sourceId) => scientLibraryIdentityProblem(work, byId.get(sourceId)!) === null,
  );
  return corroborated.length > 0
    ? { by, ids: corroborated }
    : { by: "contradicted", ids: assessment.matchingSourceIds };
}

function hydrationSourceKey(projectSourceId: string): string {
  return `project-source:${projectSourceId}`;
}

function hydrationCandidate(
  request: ScientProjectSourceRequest & { readonly work: ScientProjectSourceWork },
  citationKey: string | undefined,
): ScientSourceCandidate {
  const { work } = request;
  const candidate = {
    customType: work.customType ?? null,
    title: work.title,
    creators: work.creators,
    issuedRaw: work.issuedRaw ?? (work.issuedYear === null ? null : String(work.issuedYear)),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers,
    containerTitle: work.containerTitle,
    publisher: work.publisher ?? null,
    volume: work.volume ?? null,
    issue: work.issue ?? null,
    pages: work.pages ?? null,
    language: work.language ?? null,
    url: work.url ?? null,
    tags: work.tags ?? [],
  };
  const filled = Object.entries(candidate).filter(
    ([, value]) => value !== null && !(Array.isArray(value) && value.length === 0),
  );
  return {
    sourceKey: hydrationSourceKey(request.projectSourceId),
    ...(citationKey ? { citationKey } : {}),
    type: scientSourceTypeFromSnapshot(work.type),
    ...candidate,
    abstract: null,
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
  const file = instanceId
    ? await readInstanceMapFile(root, instanceId)
    : {
        entries: new Map<string, InstanceMapEntry>(),
        keptSeparate: new Map<string, KeptSeparate>(),
      };
  const map = file.entries;
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

  // The map can be lost, or a crash can precede its write; the trash and the tombstones of
  // sources deleted for good still say what was removed.
  let trash:
    | Promise<{ readonly libraryId: string; readonly removed: ScientSourceRecord[] }>
    | undefined;
  const removedIds = async ({
    projectSourceId,
    work,
  }: ScientProjectSourceRequest): Promise<ReadonlyArray<string>> => {
    trash ??= Promise.all([
      readScientLibraryManifest(root),
      readScientSourceTrashEntries(library),
      readScientSourceTombstones(library),
    ]).then(([{ libraryId }, entries, deleted]) => ({
      libraryId,
      // A merge moves the losing record to the trash; that is not a removal while the winner lives.
      removed: [...entries, ...deleted]
        .filter((entry) => !entry.mergedInto || liveTarget(entry.sourceId) === null)
        .map((entry) => entry.record),
    }));
    const { libraryId, removed } = await trash;
    const ids = new Set([
      projectSourceId,
      resolveScientLibraryAlias(aliases, projectSourceId),
      scientSourceIdFor(libraryId, hydrationSourceKey(projectSourceId)),
    ]);
    const byId = removed.filter((record) => ids.has(record.sourceId));
    const match = byId.length === 0 && work !== null ? matchWork(work, removed) : null;
    const found =
      byId.length > 0
        ? byId.map((record) => record.sourceId)
        : match?.by === "contradicted"
          ? []
          : (match?.ids ?? []);
    return [...new Set(found)];
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
    if (match && match.by !== "contradicted" && match.ids.length === 1) {
      const sourceId = match.ids[0]!;
      record(projectSourceId, sourceId, match.by);
      results.push({ kind: "resolved", projectSourceId, sourceId, by: match.by });
      continue;
    }
    if (match) {
      results.push({
        kind: "unresolved",
        projectSourceId,
        reason: match.by === "contradicted" ? "contradicted" : "ambiguous",
        candidateIds: match.ids,
        ...(file.keptSeparate.has(projectSourceId) ? { keptSeparate: true as const } : {}),
      });
      continue;
    }
    const removed = mapped
      ? [resolveScientLibraryAlias(aliases, mapped.sourceId)]
      : await removedIds(request);
    if (removed.length > 0) {
      results.push({
        kind: "unresolved",
        projectSourceId,
        reason: "removed",
        candidateIds: removed,
      });
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
    await writeInstanceMap(root, instanceId, recorded, file.keptSeparate);
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

export type ScientProjectSourceLinkResult =
  | { readonly outcome: "linked" | "unchanged"; readonly sourceId: string }
  | { readonly outcome: "not-found" };

/**
 * Links a project source ID to a Library source on purpose, for a pin or review record the
 * automatic steps leave on its snapshot (`contradicted` or `ambiguous`). The pin keeps its key,
 * project note and review membership: they hang on the project source ID. Undo:
 * `unlinkScientProjectSource`.
 */
export async function linkScientProjectSource(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly projectSourceId: string;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
}): Promise<ScientProjectSourceLinkResult> {
  assertSafeIdentifier(input.projectSourceId, "Source ID");
  assertSafeIdentifier(input.sourceId, "Source ID");
  const root = await NodeFSP.realpath(input.library.root);
  return withScientLibraryLock(root, async () => {
    const instanceId = await projectInstanceId(input.library, input.projectRoot, "write");
    if (!instanceId) return { outcome: "not-found" as const };
    const aliases = await readLibraryAliasesAt(root);
    const target = resolveScientLibraryAlias(aliases, input.sourceId);
    const records = await listScientSourceRecords(input.library);
    if (!records.some((record) => record.sourceId === target)) {
      return { outcome: "not-found" as const };
    }
    const { entries, keptSeparate } = await readInstanceMapFile(root, instanceId);
    const current = entries.get(input.projectSourceId);
    if (current && resolveScientLibraryAlias(aliases, current.sourceId) === target) {
      return { outcome: "unchanged" as const, sourceId: target };
    }
    const replaced =
      current?.resolvedBy === "linked"
        ? current.replaced
        : current && {
            projectSourceId: current.projectSourceId,
            sourceId: current.sourceId,
            resolvedBy: current.resolvedBy,
            resolvedAt: current.resolvedAt,
          };
    entries.set(input.projectSourceId, {
      projectSourceId: input.projectSourceId,
      sourceId: target,
      resolvedBy: "linked",
      resolvedAt: new Date().toISOString(),
      linkedBy: input.actor,
      ...(replaced ? { replaced } : {}),
    });
    keptSeparate.delete(input.projectSourceId);
    await writeInstanceMap(root, instanceId, entries, keptSeparate);
    return { outcome: "linked" as const, sourceId: target };
  });
}

/** Undoes `linkScientProjectSource`: the pin resolves as it did before, or from its snapshot. */
export async function unlinkScientProjectSource(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly projectSourceId: string;
}): Promise<{ readonly outcome: "unlinked" | "not-linked" }> {
  assertSafeIdentifier(input.projectSourceId, "Source ID");
  const root = await NodeFSP.realpath(input.library.root);
  return withScientLibraryLock(root, async () => {
    const instanceId = await projectInstanceId(input.library, input.projectRoot, "read");
    if (!instanceId) return { outcome: "not-linked" as const };
    const { entries, keptSeparate } = await readInstanceMapFile(root, instanceId);
    const current = entries.get(input.projectSourceId);
    if (current?.resolvedBy !== "linked") return { outcome: "not-linked" as const };
    if (current.replaced) entries.set(input.projectSourceId, { ...current.replaced });
    else entries.delete(input.projectSourceId);
    await writeInstanceMap(root, instanceId, entries, keptSeparate);
    return { outcome: "unlinked" as const };
  });
}

/**
 * Records that a pin is none of the Library sources it was compared with (`separate: true`), or
 * withdraws that decision. The pin stays on its snapshot either way; the decision only stops
 * asking.
 */
export async function keepScientProjectSourceSeparate(input: {
  readonly library: ScientLibraryLocation;
  readonly projectRoot: string;
  readonly projectSourceId: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly separate: boolean;
  readonly actor: ScientSourceActor;
}): Promise<{ readonly outcome: "kept-separate" | "cleared" | "unchanged" }> {
  assertSafeIdentifier(input.projectSourceId, "Source ID");
  const root = await NodeFSP.realpath(input.library.root);
  return withScientLibraryLock(root, async () => {
    const instanceId = await projectInstanceId(input.library, input.projectRoot, "write");
    if (!instanceId) return { outcome: "unchanged" as const };
    const { entries, keptSeparate } = await readInstanceMapFile(root, instanceId);
    if (input.separate === keptSeparate.has(input.projectSourceId)) {
      return { outcome: "unchanged" as const };
    }
    if (input.separate) {
      keptSeparate.set(input.projectSourceId, {
        projectSourceId: input.projectSourceId,
        sourceIds: [...input.sourceIds],
        decidedAt: new Date().toISOString(),
        decidedBy: input.actor,
      });
    } else {
      keptSeparate.delete(input.projectSourceId);
    }
    await writeInstanceMap(root, instanceId, entries, keptSeparate);
    return { outcome: input.separate ? ("kept-separate" as const) : ("cleared" as const) };
  });
}
