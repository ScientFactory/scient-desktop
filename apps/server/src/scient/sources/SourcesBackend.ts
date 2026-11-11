// @effect-diagnostics nodeBuiltinImport:off -- The library location is a folder beside the Promise-based Sources store.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ensureScientLibrary,
  isScientLibraryLocation,
  scientLibraryLocation,
  scientLibraryRootFor,
  type ScientLibraryLocation,
  type ScientSourceStoreLocation,
} from "@scientfactory/scient-sources/library-root";
import { SCIENT_SOURCE_FILES_DIRECTORY } from "@scientfactory/scient-sources/store";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";

export type ScientSourcesBackendKind = "project" | "library";

/** The Sources backend this build runs. Only the switch (5e) changes it; no setting reaches it. */
const SCIENT_SOURCES_BACKEND: ScientSourcesBackendKind = "project";

/** Tests select the library through this reference; production code only reads its default. */
export const ScientSourcesBackend = Context.Reference<ScientSourcesBackendKind>(
  "scient/sources/ScientSourcesBackend",
  { defaultValue: () => SCIENT_SOURCES_BACKEND },
);

/** `write` only for calls holding `sources:write`; `read` writes nothing anywhere. */
export type ScientSourcesAccess = "read" | "write";

export interface ScientSourcesProject {
  readonly projectId: string;
  readonly root: string;
}

export type ScientSourcesStore =
  | (ScientSourcesProject & { readonly kind: "project"; readonly store: string })
  | (ScientSourcesProject & {
      readonly kind: "library";
      readonly library: ScientLibraryLocation;
      readonly store: ScientLibraryLocation;
      readonly access: ScientSourcesAccess;
      /** False only for a read on a computer whose library was never created. */
      readonly exists: boolean;
    });

export type ScientSourcesLibraryStore = Extract<ScientSourcesStore, { readonly kind: "library" }>;

async function libraryExists(root: string): Promise<boolean> {
  return NodeFSP.lstat(NodePath.join(root, "library.json")).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

/**
 * Where a Sources call reads and writes: today's project root, or the project root plus the
 * personal library under the server's state folder. A write call creates the library once.
 */
export const resolveScientSourcesStoreFor = Effect.fn("ScientSourcesBackend.resolve")(function* (
  project: ScientSourcesProject,
  access: ScientSourcesAccess,
) {
  const backend = yield* ScientSourcesBackend;
  if (backend === "project") {
    return { kind: "project", ...project, store: project.root } satisfies ScientSourcesStore;
  }
  // Read optionally, so the project backend adds no service requirement to any caller.
  const config = yield* Effect.serviceOption(ServerConfig);
  if (Option.isNone(config)) {
    return yield* Effect.die(new Error("The library backend needs the server configuration."));
  }
  const root = scientLibraryRootFor(config.value.stateDir);
  const exists = yield* Effect.promise(() =>
    access === "write" ? ensureScientLibrary(root).then(() => true) : libraryExists(root),
  );
  const library = scientLibraryLocation(root);
  return {
    kind: "library",
    ...project,
    library,
    store: library,
    access,
    exists,
  } satisfies ScientSourcesStore;
});

/** A stable string for per-store caches and lanes; a library never shares one with a project. */
export function scientSourceStoreKey(location: ScientSourceStoreLocation): string {
  return isScientLibraryLocation(location) ? `library:${location.root}` : location;
}

/** The same location with its root's real path, as the store canonicalizes it. */
export async function canonicalScientSourceLocation<L extends ScientSourceStoreLocation>(
  location: L,
): Promise<L> {
  if (!isScientLibraryLocation(location)) return (await NodeFSP.realpath(location)) as L;
  return scientLibraryLocation(await NodeFSP.realpath(location.root)) as L;
}

/** Where a store keeps the PDF with this hash. */
export function scientSourceStorePdfPath(
  location: ScientSourceStoreLocation,
  sha256: string,
): string {
  const folder = isScientLibraryLocation(location)
    ? NodePath.join(location.root, "files", "sha256")
    : NodePath.join(location, SCIENT_SOURCE_FILES_DIRECTORY);
  return NodePath.join(folder, sha256.slice(0, 2), `${sha256}.pdf`);
}
