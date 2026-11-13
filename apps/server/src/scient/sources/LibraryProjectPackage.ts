// @effect-diagnostics nodeBuiltinImport:off -- The package is a folder in the project.
// @effect-diagnostics globalDate:off -- The default folder name carries the export date.
import * as NodeCrypto from "node:crypto";
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

/** A path with its existing part resolved through links, so a link cannot hide where it leads. */
async function canonicalPath(path: string): Promise<string> {
  const rest: string[] = [];
  for (let current = path; ; current = NodePath.dirname(current)) {
    const real = await NodeFSP.realpath(current).catch(() => null);
    if (real !== null) return NodePath.join(real, ...rest.toReversed());
    if (NodePath.dirname(current) === current) return path;
    rest.push(NodePath.basename(current));
  }
}

const within = (child: string, parent: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const GRANTS_FILE = "package-destinations.json";
const MAX_GRANTS = 20;
type Grants = Record<string, ReadonlyArray<string>>;

async function readGrants(store: ScientSourcesLibraryStore): Promise<Grants> {
  try {
    const value: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(store.library.root, GRANTS_FILE), "utf8"),
    );
    return value !== null && typeof value === "object" ? (value as Grants) : {};
  } catch {
    return {};
  }
}

/** A folder the person chose for this project's packages, which its agents may then use too. */
async function grantDestination(store: ScientSourcesLibraryStore, folder: string): Promise<void> {
  const { projectId } = await readScientProjectIdentity(store.root);
  const grants = await readGrants(store);
  const folders = [folder, ...(grants[projectId] ?? []).filter((entry) => entry !== folder)];
  const path = NodePath.join(store.library.root, GRANTS_FILE);
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(
    temporary,
    `${JSON.stringify({ ...grants, [projectId]: folders.slice(0, MAX_GRANTS) }, null, 2)}\n`,
  );
  await NodeFSP.rename(temporary, path);
}

/**
 * Where a package may be written, checked before any folder is made: never inside the project's
 * `.scient`; for an agent, only inside the project or a folder the person chose for its packages
 * (links resolved first). The person's own choice of an outside folder grants it.
 */
async function checkedDestination(
  store: ScientSourcesLibraryStore,
  destination: string,
  caller: "person" | "agent",
): Promise<void> {
  const target = await canonicalPath(destination);
  const root = await canonicalPath(store.root);
  if (within(target, NodePath.join(root, ".scient"))) {
    throw new Error("A package cannot be saved inside the project's .scient folder.");
  }
  if (within(target, root)) return;
  const parent = NodePath.dirname(target);
  if (caller === "person") {
    await grantDestination(store, parent);
    return;
  }
  const { projectId } = await readScientProjectIdentity(store.root);
  const granted = (await readGrants(store))[projectId] ?? [];
  if (!granted.some((folder) => typeof folder === "string" && within(parent, folder))) {
    throw new Error(
      "An agent saves a package inside this project, or in a folder the person chose for its packages in the Sources panel.",
    );
  }
}

/**
 * Where an agent may read a package from, checked before the manifest is read: inside the project
 * (never its `.scient`) or a folder the person chose for this project's packages, links resolved
 * first. The package's own files are checked against it as they are read.
 */
async function checkedPackageSource(
  store: ScientSourcesLibraryStore,
  folder: string,
): Promise<string> {
  const target = await canonicalPath(folder);
  const root = await canonicalPath(store.root);
  if (within(target, NodePath.join(root, ".scient"))) {
    throw new Error("A package is not read from inside the project's .scient folder.");
  }
  if (within(target, root)) return target;
  const { projectId } = await readScientProjectIdentity(store.root);
  const granted = (await readGrants(store))[projectId] ?? [];
  if (!granted.some((entry) => typeof entry === "string" && within(target, entry))) {
    throw new Error(
      "An agent imports a package from inside this project, or from a folder the person chose for its packages in the Sources panel.",
    );
  }
  return target;
}

export async function exportLibraryProjectPackage(
  store: ScientSourcesLibraryStore,
  input: { readonly relativePath?: string; readonly inFolder?: string },
  caller: "person" | "agent",
) {
  if (input.inFolder !== undefined && !NodePath.isAbsolute(input.inFolder)) {
    throw new Error("inFolder must be an absolute path.");
  }
  const destination =
    input.relativePath !== undefined
      ? packageFolder(store.root, input.relativePath)
      : await freshPackageFolder(input.inFolder ?? store.root);
  await checkedDestination(store, destination, caller);
  const exported = await exportScientProjectPackage({
    projectRoot: store.root,
    library: store.library,
    relativePath: destination,
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
  const requested = packageFolder(store.root, input.relativePath);
  const folder =
    actor === "agent"
      ? await checkedPackageSource(store, requested)
      : await canonicalPath(requested);
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
  // The person's own choice of an outside package lets this project's agents read there too.
  if (actor !== "agent" && !within(folder, await canonicalPath(store.root))) {
    await grantDestination(store, NodePath.dirname(folder));
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
      left: undone.left,
    },
  };
}
