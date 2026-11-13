// @effect-diagnostics nodeBuiltinImport:off -- The package is a folder in the project.
// @effect-diagnostics globalDate:off -- The default folder name carries the export date.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ScientSourceActor } from "@scientfactory/scient-sources";
import {
  exportScientProjectPackage,
  importScientProjectPackage,
  listScientProjectPackages,
} from "@scientfactory/scient-sources/project-package";

import type { ScientSourcesLibraryStore } from "./SourcesBackend.ts";
import { syncProjectBibliography } from "./LibraryProjectSources.ts";

/** A new top-level folder: "Scient project package 2026-11-13", then " 2", " 3". */
async function freshPackageFolder(root: string): Promise<string> {
  const name = `Scient project package ${new Date().toISOString().slice(0, 10)}`;
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? name : `${name} ${index}`;
    if (!(await NodeFSP.lstat(NodePath.join(root, candidate)).catch(() => null))) return candidate;
  }
}

function insideProject(root: string, relativePath: string): string {
  const folder = NodePath.resolve(root, relativePath);
  const relative = NodePath.relative(root, folder);
  if (!relative || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new Error("The package folder must be inside the project.");
  }
  return folder;
}

export async function exportLibraryProjectPackage(
  store: ScientSourcesLibraryStore,
  input: { readonly relativePath?: string },
) {
  const exported = await exportScientProjectPackage({
    projectRoot: store.root,
    library: store.library,
    relativePath: input.relativePath ?? (await freshPackageFolder(store.root)),
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
  const folder = insideProject(store.root, input.relativePath);
  const imported = await importScientProjectPackage({
    projectRoot: store.root,
    library: store.library,
    folder,
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
      sources: imported.sources.added,
      sourcesMatched: imported.sources.matched,
      pdfs: imported.pdfs.added,
      annotations: imported.annotations,
      pins: imported.pins.added,
      notesKept: imported.pins.notesKept,
      reviews: imported.reviews.added,
      reviewConflicts: imported.reviews.conflicts,
      collections: imported.collections,
      unavailable: imported.unavailable.length,
    },
  };
}
