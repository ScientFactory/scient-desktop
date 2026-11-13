// @effect-diagnostics nodeBuiltinImport:off -- The package is a folder in the project.
// @effect-diagnostics globalDate:off -- The default folder name carries the export date.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ScientSourceActor } from "@scientfactory/scient-sources";
import { readScientProjectIdentity } from "@scientfactory/project-init";
import {
  exportScientProjectPackage,
  importScientProjectPackage,
  listScientProjectPackages,
  undoScientProjectPackageImport,
} from "@scientfactory/scient-sources/project-package";

import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";
import { syncProjectBibliography } from "./LibraryProjectSources.ts";

/** A new folder in `parent`: "Scient project package 2026-11-13", then " 2", " 3". */
async function freshPackageFolder(parent: string): Promise<string> {
  const name = `Scient project package ${new Date().toISOString().slice(0, 10)}`;
  for (let index = 1; ; index += 1) {
    const candidate = NodePath.join(parent, index === 1 ? name : `${name} ${index}`);
    if (!(await NodeFSP.lstat(candidate).catch(() => null))) return candidate;
  }
}

/** A folder in the project, or an absolute path on this server's computer. */
function packageFolder(root: string, path: string): string {
  return NodePath.isAbsolute(path) ? NodePath.normalize(path) : NodePath.resolve(root, path);
}

export async function exportLibraryProjectPackage(
  store: ScientSourcesLibraryStore,
  input: { readonly relativePath?: string; readonly inFolder?: string },
) {
  if (input.inFolder !== undefined && !NodePath.isAbsolute(input.inFolder)) {
    throw new Error("inFolder must be an absolute path.");
  }
  const exported = await exportScientProjectPackage({
    projectRoot: store.root,
    library: store.library,
    relativePath:
      input.relativePath !== undefined
        ? packageFolder(store.root, input.relativePath)
        : await freshPackageFolder(input.inFolder ?? store.root),
  });
  const { counts } = exported;
  return {
    outcome: "exported" as const,
    packagePath: exported.relativePath,
    packageReport: {
      sources: counts.sources,
      pdfs: counts.pdfs,
      annotations: counts.annotations,
      pins: counts.pins,
      reviews: counts.reviews,
      collections: counts.collections,
      unavailable: exported.unavailable.length,
      insideProject: exported.insideProject,
    },
  };
}

export async function listLibraryProjectPackages(store: ScientSourcesLibraryStore) {
  return { outcome: "listed" as const, packages: await listScientProjectPackages(store.root) };
}

export async function importLibraryProjectPackage(
  store: ScientSourcesLibraryStore,
  input: { readonly relativePath: string },
  actor: ScientSourceActor,
) {
  const imported = await importScientProjectPackage({
    projectRoot: store.root,
    library: store.library,
    folder: packageFolder(store.root, input.relativePath),
    actor,
  });
  if (imported.outcome === "not-a-package") return { outcome: imported.outcome };
  if (imported.outcome === "package-changed") {
    return {
      outcome: imported.outcome,
      packageReport: {
        sources: 0,
        pdfs: 0,
        annotations: 0,
        pins: 0,
        reviews: 0,
        collections: 0,
        unavailable: 0,
        changedFiles: imported.files,
      },
    };
  }
  await syncProjectBibliography(store, actor);
  return {
    outcome: "imported" as const,
    packageReport: {
      importId: imported.importId,
      sources: imported.sources.added,
      sourcesMatched: imported.sources.matched,
      pdfs: imported.pdfs.added,
      annotations: imported.annotations,
      annotationConflicts: imported.annotationConflicts,
      pins: imported.pins.added,
      notesKept: imported.pins.notesKept,
      reviews: imported.reviews.added,
      reviewConflicts: imported.reviews.conflicts,
      snapshotsAdded: imported.reviews.snapshotsAdded,
      collections: imported.collections,
      unavailable: imported.unavailable.length,
      failed: imported.failed,
    },
  };
}

export async function undoLibraryProjectPackageImport(
  store: ScientSourcesLibraryStore,
  input: { readonly importId: string },
  actor: ScientSourceActor,
) {
  const { projectId } = await readScientProjectIdentity(store.root);
  const undone = await undoScientProjectPackageImport({
    projectRoot: store.root,
    projectId,
    library: store.library,
    importId: input.importId,
    actor,
  });
  if (undone.outcome !== "undone") return { outcome: undone.outcome };
  await syncProjectBibliography(store, actor);
  return {
    outcome: "undone" as const,
    packageReport: {
      sources: 0,
      pdfs: 0,
      annotations: 0,
      pins: 0,
      reviews: 0,
      collections: 0,
      unavailable: 0,
      kept: undone.kept,
    },
  };
}
