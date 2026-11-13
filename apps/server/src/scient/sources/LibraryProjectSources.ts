// @effect-diagnostics nodeBuiltinImport:off -- Library-mode Sources read other checkouts' pin files through the Promise-based store.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ScientSourceActor, ScientSourceReadingStatus } from "@scientfactory/scient-sources";
import {
  readScientLibraryAliases,
  resolveScientLibraryAlias,
} from "@scientfactory/scient-sources/library-aliases";
import {
  resolveScientProjectSources,
  type ScientProjectSourceResolution,
} from "@scientfactory/scient-sources/library-instance-map";
import {
  listScientLibraryReviewIds,
  refreshScientLibraryReviewSnapshot,
} from "@scientfactory/scient-sources/library-reviews";
import { listScientLibraryInstances } from "@scientfactory/scient-sources/library-root";
import {
  listScientProjectPinnedWorks,
  readScientProjectPins,
  refreshScientProjectPinSnapshots,
  resolveScientProjectPins,
  type ScientProjectPin,
  type ScientProjectPinnedWork,
} from "@scientfactory/scient-sources/project-pins";
import {
  readScientSourceRecord,
  setScientLibraryReadingState,
} from "@scientfactory/scient-sources/store";

import { syncPinnedBibliography } from "./ManagedBibliography.ts";
import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";

/**
 * This project's pinned works under their project keys; with write access, unresolved pins are
 * hydrated first, otherwise they come from their snapshot.
 */
export async function listProjectPinnedWorks(
  store: ScientSourcesLibraryStore,
  actor: ScientSourceActor,
): Promise<ReadonlyArray<ScientProjectPinnedWork>> {
  if (store.access === "write") {
    await resolveScientProjectPins({
      projectRoot: store.root,
      library: store.library,
      mode: "write",
      actor,
    });
  }
  return listScientProjectPinnedWorks({
    projectRoot: store.root,
    library: store.exists ? store.library : null,
  });
}

/** Rewrites this project's managed files from its pins; only with write access. */
export async function syncProjectBibliography(
  store: ScientSourcesLibraryStore,
  actor: ScientSourceActor,
): Promise<void> {
  if (store.access !== "write") return;
  await syncPinnedBibliography({
    root: store.root,
    library: store.library,
    access: "write",
    actor,
  });
}

/**
 * Two pins can name one source: a project that used both sides of a pair keeps both pins after
 * they are merged, so documents citing either key still work. The project lists the source once,
 * under the key it pinned first (the one its documents have had longest); `alsoCitedAs` holds the
 * other keys, which stay in the bibliography. Entries keep the order of their first pin.
 */
function groupPins<Entry>(
  entries: ReadonlyArray<Entry>,
  groupOf: (entry: Entry) => string,
  pinOf: (entry: Entry) => { readonly citationKey: string; readonly pinnedAt: string },
): ReadonlyArray<{ readonly entry: Entry; readonly alsoCitedAs: ReadonlyArray<string> }> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const group = groups.get(groupOf(entry));
    if (group) group.push(entry);
    else groups.set(groupOf(entry), [entry]);
  }
  return [...groups.values()].map((group) => {
    const entry = group.reduce((first, next) =>
      pinOf(next).pinnedAt < pinOf(first).pinnedAt ? next : first,
    );
    return {
      entry,
      alsoCitedAs: group
        .filter((other) => other !== entry)
        .map((other) => pinOf(other).citationKey),
    };
  });
}

/** This project's pinned works, one per source, as `groupPins` describes. */
export function distinctPinnedWorks(
  works: ReadonlyArray<ScientProjectPinnedWork>,
): ReadonlyArray<ScientProjectPinnedWork & { readonly alsoCitedAs: ReadonlyArray<string> }> {
  return groupPins(
    works,
    // A snapshot names no library record, so each stays its own source.
    (work) =>
      work.from === "library" ? `library\0${work.record.sourceId}` : `pin\0${work.projectSourceId}`,
    (work) => work,
  ).map(({ entry, alsoCitedAs }) => ({ ...entry, alsoCitedAs }));
}

export interface ProjectPinGroup {
  readonly pin: ScientProjectPin;
  readonly alsoCitedAs: ReadonlyArray<string>;
}

/** This project's pins by the library record each resolves to, with the keys `groupPins` folds. */
export async function projectPinGroupsByLibraryId(
  store: ScientSourcesLibraryStore,
): Promise<ReadonlyMap<string, ProjectPinGroup>> {
  if (!store.exists) return new Map();
  const resolved = await resolveScientProjectPins({
    projectRoot: store.root,
    library: store.library,
    mode: "read",
    actor: "agent",
  });
  const pinned = resolved.flatMap(({ pin, resolution }) =>
    resolution.kind === "resolved" ? [{ pin, sourceId: resolution.sourceId }] : [],
  );
  return new Map(
    groupPins(
      pinned,
      (entry) => entry.sourceId,
      (entry) => entry.pin,
    ).map(({ entry, alsoCitedAs }) => [entry.sourceId, { pin: entry.pin, alsoCitedAs }] as const),
  );
}

/** This project's pin of each library record it uses (the first pinned); reading writes nothing. */
export async function projectPinsByLibraryId(
  store: ScientSourcesLibraryStore,
): Promise<ReadonlyMap<string, ScientProjectPin>> {
  const groups = await projectPinGroupsByLibraryId(store);
  return new Map([...groups].map(([sourceId, group]) => [sourceId, group.pin] as const));
}

/**
 * The library record a caller means: a library ID (merged IDs follow their alias), or a project
 * source ID this project stores, resolved through the instance map. Read access records nothing.
 */
export async function resolveLibrarySourceId(
  store: ScientSourcesLibraryStore,
  sourceId: string,
): Promise<string | null> {
  if (!store.exists) return null;
  const target = resolveScientLibraryAlias(await readScientLibraryAliases(store.library), sourceId);
  if (await readScientSourceRecord(store.library, target)) return target;
  const pin = (await readScientProjectPins(store.root)).find(
    (candidate) => candidate.sourceId === sourceId,
  );
  const [resolution] = await resolveScientProjectSources({
    library: store.library,
    projectRoot: store.root,
    mode: store.access,
    sources: [{ projectSourceId: sourceId, work: pin?.work ?? null }],
  });
  return resolution?.kind === "resolved" ? resolution.sourceId : null;
}

const RECORD_READS_AT_ONCE = 32;

/** Many IDs as `resolveLibrarySourceId` resolves one, reading aliases and pins once; unresolved IDs stay. */
export async function resolveLibrarySourceIds(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<readonly [requested: string, libraryId: string]>> {
  if (!store.exists) return sourceIds.map((sourceId) => [sourceId, sourceId] as const);
  const aliases = await readScientLibraryAliases(store.library);
  const found = new Map<string, string>();
  const unresolved: string[] = [];
  const unique = [...new Set(sourceIds)];
  // One read at a time took 2.6 s for 19,000 IDs (scale gate).
  for (let start = 0; start < unique.length; start += RECORD_READS_AT_ONCE) {
    const part = unique.slice(start, start + RECORD_READS_AT_ONCE);
    const targets = part.map((sourceId) => resolveScientLibraryAlias(aliases, sourceId));
    const records = await Promise.all(
      targets.map((target) => readScientSourceRecord(store.library, target)),
    );
    for (const [index, sourceId] of part.entries()) {
      if (records[index]) found.set(sourceId, targets[index]!);
      else unresolved.push(sourceId);
    }
  }
  if (unresolved.length > 0) {
    const pins = new Map(
      (await readScientProjectPins(store.root)).map((pin) => [pin.sourceId, pin] as const),
    );
    const resolutions = await resolveScientProjectSources({
      library: store.library,
      projectRoot: store.root,
      mode: store.access,
      sources: unresolved.map((projectSourceId) => ({
        projectSourceId,
        work: pins.get(projectSourceId)?.work ?? null,
      })),
    });
    for (const [index, sourceId] of unresolved.entries()) {
      const resolution = resolutions[index];
      if (resolution?.kind === "resolved") found.set(sourceId, resolution.sourceId);
    }
  }
  return sourceIds.map((sourceId) => [sourceId, found.get(sourceId) ?? sourceId] as const);
}

async function folderExists(path: string): Promise<boolean> {
  return NodeFSP.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

/**
 * How many other checkouts on this computer pin the record, for the reach an edit reports.
 * Their pins are only read; a checkout whose folder is gone is skipped.
 */
async function otherProjectsPinning(
  store: ScientSourcesLibraryStore,
  sourceId: string,
): Promise<number> {
  if (!store.exists) return 0;
  const here = await NodeFSP.realpath(store.root);
  let count = 0;
  for (const instance of await listScientLibraryInstances(store.library)) {
    if (instance.path === here || !(await folderExists(instance.path))) continue;
    const pinned = await resolveScientProjectPins({
      projectRoot: instance.path,
      library: store.library,
      mode: "read",
      actor: "agent",
    }).catch(() => []);
    if (
      pinned.some(
        ({ resolution }) => resolution.kind === "resolved" && resolution.sourceId === sourceId,
      )
    ) {
      count += 1;
    }
  }
  return count;
}

/** A project the server knows, as the project list names it. */
export interface KnownProject {
  readonly workspaceRoot: string;
  readonly title: string;
}

/**
 * Names checkouts on this computer by the Library IDs `idsOf` reads from each of their pin
 * resolutions, by their title in `projects` or else their folder name. One pin resolution per
 * checkout, whatever the number of sources asked about.
 */
async function projectsNamedBy(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlySet<string>,
  projects: ReadonlyArray<KnownProject>,
  includeHere: boolean,
  idsOf: (resolution: ScientProjectSourceResolution) => ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const names = new Map<string, string[]>();
  if (!store.exists || sourceIds.size === 0) return names;
  const here = await NodeFSP.realpath(store.root);
  // Checkouts are registered by real path; the project list keeps the path it was opened with.
  const titles = new Map(
    await Promise.all(
      projects.map(
        async (project) =>
          [
            await NodeFSP.realpath(project.workspaceRoot).catch(() => project.workspaceRoot),
            project.title,
          ] as const,
      ),
    ),
  );
  for (const instance of await listScientLibraryInstances(store.library)) {
    if ((!includeHere && instance.path === here) || !(await folderExists(instance.path))) continue;
    const pinned = await resolveScientProjectPins({
      projectRoot: instance.path,
      library: store.library,
      mode: "read",
      actor: "agent",
    }).catch(() => []);
    const name = titles.get(instance.path) ?? NodePath.basename(instance.path);
    for (const { resolution } of pinned) {
      for (const sourceId of idsOf(resolution)) {
        if (!sourceIds.has(sourceId)) continue;
        const list = names.get(sourceId) ?? [];
        if (!list.includes(name)) list.push(name);
        names.set(sourceId, list);
      }
    }
  }
  return names;
}

/** For each of `sourceIds`, the other checkouts on this computer that pin it. */
export function otherProjectsUsing(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlySet<string>,
  projects: ReadonlyArray<KnownProject> = [],
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  return projectsNamedBy(store, sourceIds, projects, false, (resolution) =>
    resolution.kind === "resolved" ? [resolution.sourceId] : [],
  );
}

/**
 * For each of `sourceIds` in the trash, the checkouts on this computer, this one included, that
 * still cite it: deleted for good, they keep citing it from their own snapshot.
 */
export function projectsCitingRemoved(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlySet<string>,
  projects: ReadonlyArray<KnownProject> = [],
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  return projectsNamedBy(store, sourceIds, projects, true, (resolution) =>
    resolution.kind === "unresolved" && resolution.reason === "removed"
      ? resolution.candidateIds
      : [],
  );
}

/** The reach field an edit result carries; absent when no other project pins the record. */
export async function alsoPinnedIn(
  store: ScientSourcesLibraryStore,
  sourceId: string,
): Promise<{ readonly alsoPinnedIn?: number }> {
  const count = await otherProjectsPinning(store, sourceId).catch(() => 0);
  return count > 0 ? { alsoPinnedIn: count } : {};
}

/**
 * After library records change, refreshes every pin snapshot of this project (so one left stale
 * by a failure or another project is caught up), the snapshots of its reviews that name them,
 * and its managed bibliography. Each writes only when bytes change.
 */
export async function refreshProjectAfterLibraryChange(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlyArray<string>,
  actor: ScientSourceActor,
): Promise<void> {
  if (store.access !== "write" || sourceIds.length === 0) return;
  const changed = new Set(sourceIds);
  await refreshScientProjectPinSnapshots({ projectRoot: store.root, library: store.library });
  for (const reviewId of await listScientLibraryReviewIds(store.root)) {
    await refreshScientLibraryReviewSnapshot({
      projectRoot: store.root,
      library: store.library,
      reviewId,
      naming: changed,
    });
  }
  await syncProjectBibliography(store, actor);
}

/** Read or unread, starred or not, for one source or many; each answers under its own ID. */
export async function setLibraryReadingState(
  store: ScientSourcesLibraryStore,
  input: {
    readonly sourceIds: ReadonlyArray<string>;
    readonly readingStatus?: ScientSourceReadingStatus;
    readonly starred?: boolean;
  },
) {
  if (input.readingStatus === undefined && input.starred === undefined) {
    throw new Error("Give readingStatus or starred.");
  }
  const resolved = await resolveLibrarySourceIds(store, input.sourceIds);
  const changes = store.exists
    ? await setScientLibraryReadingState({
        library: store.library,
        sourceIds: resolved.map(([, libraryId]) => libraryId),
        ...(input.readingStatus ? { readingStatus: input.readingStatus } : {}),
        ...(input.starred !== undefined ? { starred: input.starred } : {}),
      })
    : [];
  const byId = new Map(changes.map((change) => [change.sourceId, change]));
  return {
    sources: resolved.map(([sourceId, libraryId]) => ({
      ...(byId.get(libraryId) ?? { outcome: "not-found" as const }),
      sourceId,
    })),
  };
}
