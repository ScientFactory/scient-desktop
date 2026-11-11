// @effect-diagnostics nodeBuiltinImport:off -- Library-mode Sources read other checkouts' pin files through the Promise-based store.
import * as NodeFSP from "node:fs/promises";

import type { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  readScientLibraryAliases,
  resolveScientLibraryAlias,
} from "@scientfactory/scient-sources/library-aliases";
import { resolveScientProjectSources } from "@scientfactory/scient-sources/library-instance-map";
import {
  listScientLibraryReviewRecords,
  listScientLibraryReviews,
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
import { readScientSourceRecord } from "@scientfactory/scient-sources/store";

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

/** This project's pins by the library record each resolves to; reading writes nothing. */
export async function projectPinsByLibraryId(
  store: ScientSourcesLibraryStore,
): Promise<ReadonlyMap<string, ScientProjectPin>> {
  if (!store.exists) return new Map();
  const resolved = await resolveScientProjectPins({
    projectRoot: store.root,
    library: store.library,
    mode: "read",
    actor: "agent",
  });
  return new Map(
    resolved.flatMap(({ pin, resolution }) =>
      resolution.kind === "resolved" ? [[resolution.sourceId, pin] as const] : [],
    ),
  );
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

/** The reach field an edit result carries; absent when no other project pins the record. */
export async function alsoPinnedIn(
  store: ScientSourcesLibraryStore,
  sourceId: string,
): Promise<{ readonly alsoPinnedIn?: number }> {
  const count = await otherProjectsPinning(store, sourceId).catch(() => 0);
  return count > 0 ? { alsoPinnedIn: count } : {};
}

/**
 * After library records change, refreshes this project's pin snapshots, the snapshots of its
 * reviews that name them, and its managed bibliography. Each writes only when bytes change;
 * other projects refresh when they are next opened with write authority.
 */
export async function refreshProjectAfterLibraryChange(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlyArray<string>,
  actor: ScientSourceActor,
): Promise<void> {
  if (store.access !== "write" || sourceIds.length === 0) return;
  const changed = new Set(sourceIds);
  await refreshScientProjectPinSnapshots({ projectRoot: store.root, library: store.library });
  const { reviews } = await listScientLibraryReviews({
    projectRoot: store.root,
    library: store.library,
    mode: "read",
  });
  for (const { reviewId } of reviews) {
    const records = await listScientLibraryReviewRecords({
      projectRoot: store.root,
      library: store.library,
      reviewId,
      mode: "read",
    });
    const names = records?.some(
      (entry) => entry.from === "library" && entry.record && changed.has(entry.record.sourceId),
    );
    if (names) {
      await refreshScientLibraryReviewSnapshot({
        projectRoot: store.root,
        library: store.library,
        reviewId,
      });
    }
  }
  await syncProjectBibliography(store, actor);
}
