// @effect-diagnostics nodeBuiltinImport:off -- Library imports pin into a checkout found through the Promise-based store.
import * as NodeFSP from "node:fs/promises";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import type { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  listScientLibraryInstances,
  registerScientLibraryInstance,
  type ScientLibraryLocation,
} from "@scientfactory/scient-sources/library-root";
import {
  bindScientProjectCitationKeys,
  pinScientLibrarySource,
  type ScientCitationKeyBinding,
} from "@scientfactory/scient-sources/project-pins";

import { syncPinnedBibliography } from "./ManagedBibliography.ts";

/** The checkout instance an import started from this project pins into, registered on first use. */
export async function libraryImportPinInstance(
  library: ScientLibraryLocation,
  projectRoot: string,
): Promise<string> {
  const { projectId } = await readScientProjectIdentity(projectRoot);
  return (await registerScientLibraryInstance({ library, projectId, projectRoot })).instanceId;
}

/** The project folder of that checkout; null once the folder is gone or holds another project. */
async function pinInstanceRoot(
  library: ScientLibraryLocation,
  instanceId: string,
): Promise<string | null> {
  const instance = (await listScientLibraryInstances(library)).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!instance) return null;
  const identity = await readScientProjectIdentity(instance.path).catch(() => null);
  return identity?.projectId === instance.projectId
    ? await NodeFSP.realpath(instance.path).catch(() => null)
    : null;
}

/** Pins library records into the import's project; pinning one already pinned changes nothing. */
export async function pinLibraryImport(input: {
  readonly library: ScientLibraryLocation;
  readonly instanceId: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
}): Promise<void> {
  if (input.sourceIds.length === 0) return;
  const projectRoot = await pinInstanceRoot(input.library, input.instanceId);
  if (!projectRoot) return;
  for (const sourceId of new Set(input.sourceIds)) {
    await pinScientLibrarySource({
      projectRoot,
      library: input.library,
      sourceId,
      actor: input.actor,
    });
  }
}

/**
 * Binds the keys a reference file cites a library record by in the import's project; with no
 * keys, pins it as `pinLibraryImport` does. Null when the import's project folder is gone.
 */
export async function bindLibraryImportKeys(input: {
  readonly library: ScientLibraryLocation;
  readonly instanceId: string;
  readonly sourceId: string;
  readonly citationKeys: ReadonlyArray<string>;
  readonly actor: ScientSourceActor;
}): Promise<{
  readonly citationKeys: ReadonlyArray<ScientCitationKeyBinding>;
  readonly projectKey?: string;
} | null> {
  const projectRoot = await pinInstanceRoot(input.library, input.instanceId);
  if (!projectRoot) return null;
  if (input.citationKeys.length === 0) {
    const pinned = await pinScientLibrarySource({
      projectRoot,
      library: input.library,
      sourceId: input.sourceId,
      actor: input.actor,
    });
    return pinned.outcome === "not-found"
      ? null
      : { citationKeys: [], projectKey: pinned.pin.citationKey };
  }
  const bound = await bindScientProjectCitationKeys({
    projectRoot,
    library: input.library,
    sourceId: input.sourceId,
    citationKeys: input.citationKeys,
    actor: input.actor,
  });
  return bound.outcome === "not-found"
    ? null
    : {
        citationKeys: bound.bindings,
        ...(bound.projectKey ? { projectKey: bound.projectKey } : {}),
      };
}

/** Builds the import's project bibliography from its pins, once the import has settled. */
export async function syncLibraryImportBibliography(input: {
  readonly library: ScientLibraryLocation;
  readonly instanceId: string;
  readonly actor: ScientSourceActor;
}): Promise<void> {
  const projectRoot = await pinInstanceRoot(input.library, input.instanceId);
  if (!projectRoot) return;
  await syncPinnedBibliography({
    root: projectRoot,
    library: input.library,
    access: "write",
    actor: input.actor,
  });
}
