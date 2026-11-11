// @effect-diagnostics nodeBuiltinImport:off -- The library location is a folder beside the Promise-based Sources store.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import type { ScientSourceActor } from "@scientfactory/scient-sources";
import { readScientLibraryMoveState } from "@scientfactory/scient-sources/library-move";
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
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { moveProjectIntoLibrary } from "./LibraryMove.ts";

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

/** Reads only. A folder that cannot be inspected keeps the library answer it had before 5d. */
const projectNotMoved = (root: string, library: ScientLibraryLocation | null) =>
  Effect.promise(() =>
    readScientLibraryMoveState({ library, projectRoot: root }).then(
      (state) => !state.moved,
      () => false,
    ),
  );

/** Until a project is moved, its v1 store stays the truth, whichever backend this build runs. */
const projectStore = (project: ScientSourcesProject): ScientSourcesStore => ({
  kind: "project",
  ...project,
  store: project.root,
});

/**
 * Where a Sources call reads and writes: today's project root, or the project root plus the
 * personal library under the server's state folder. A write call creates the library once and
 * moves the project into it first (section 5); a read on a project not yet moved reads its v1
 * store and never starts the move.
 */
export const resolveScientSourcesStoreFor = Effect.fn("ScientSourcesBackend.resolve")(function* (
  project: ScientSourcesProject,
  access: ScientSourcesAccess,
  actor: ScientSourceActor = "user",
  /** Background work waits for a running move; a request waits its bound (`ScientLibraryMoveWait`). */
  wait: "bounded" | "until-done" = "bounded",
) {
  const backend = yield* ScientSourcesBackend;
  if (backend === "project") return projectStore(project);
  // Read optionally, so the project backend adds no service requirement to any caller.
  const config = yield* Effect.serviceOption(ServerConfig);
  if (Option.isNone(config)) {
    return yield* Effect.die(new Error("The library backend needs the server configuration."));
  }
  const root = scientLibraryRootFor(config.value.stateDir);
  const library = scientLibraryLocation(root);
  let exists: boolean;
  if (access === "write") {
    yield* Effect.promise(() => ensureScientLibrary(root));
    exists = true;
    const outcome = yield* moveProjectIntoLibrary({ root: project.root, library, actor, wait });
    if (outcome === "moved-back" || outcome === "waiting-import") return projectStore(project);
    if (outcome === "failed" && (yield* projectNotMoved(project.root, library))) {
      return projectStore(project);
    }
  } else {
    exists = yield* Effect.promise(() => libraryExists(root));
    if (yield* projectNotMoved(project.root, exists ? library : null)) {
      return projectStore(project);
    }
  }
  return {
    kind: "library",
    ...project,
    library,
    store: library,
    access,
    exists,
  } satisfies ScientSourcesStore;
});

class ScientLibraryProjectError extends Schema.TaggedError<ScientLibraryProjectError>()(
  "ScientLibraryProjectError",
  { message: Schema.String },
) {}

/**
 * Library mode only: the library store for a caller that knows just the project folder, such as
 * the papers queue. Under the project backend it is null and reads nothing.
 */
export const resolveScientLibraryStoreAt = Effect.fn("ScientSourcesBackend.resolveLibraryAt")(
  function* (
    root: string,
    access: ScientSourcesAccess,
    wait: "bounded" | "until-done" = "bounded",
  ) {
    if ((yield* ScientSourcesBackend) === "project") return null;
    const { projectId } = yield* Effect.tryPromise({
      try: () => readScientProjectIdentity(root),
      catch: () =>
        new ScientLibraryProjectError({ message: "This folder is not a Scient project." }),
    });
    const store = yield* resolveScientSourcesStoreFor({ projectId, root }, access, "user", wait);
    return store.kind === "library" ? store : null;
  },
);

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
