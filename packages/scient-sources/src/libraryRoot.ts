// @effect-diagnostics nodeBuiltinImport:off -- The personal library is Scient's user-level source store.
// @effect-diagnostics globalDate:off -- Library files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { withScientLibraryLock } from "./libraryLock.ts";
import {
  atomicCreateJson,
  atomicWriteJson,
  ensureDirectory,
  readBoundedJson,
  snapshot,
} from "./storeFiles.ts";

/** Where the server keeps the library, under its resolved state directory for the launch mode. */
export const SCIENT_LIBRARY_STATE_PATH = ["scient", "library"] as const;
export const SCIENT_LIBRARY_MANIFEST_FILE = "library.json";
export const SCIENT_LIBRARY_INSTANCES_FILE = "instances.json";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTANCES_BYTES = 4 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

/**
 * A personal library root. Store functions take either a project root (a string) or one of these,
 * so the same code serves both. Nothing routes a request to a library until the switch (5e).
 */
export interface ScientLibraryLocation {
  readonly kind: "scient-library";
  readonly root: string;
}

export type ScientSourceStoreLocation = string | ScientLibraryLocation;

export function scientLibraryLocation(root: string): ScientLibraryLocation {
  return { kind: "scient-library", root };
}

export function isScientLibraryLocation(
  location: ScientSourceStoreLocation,
): location is ScientLibraryLocation {
  return typeof location !== "string";
}

/** The library under a server state directory: `<stateDir>/scient/library`. */
export function scientLibraryRootFor(stateDir: string): string {
  return NodePath.join(stateDir, ...SCIENT_LIBRARY_STATE_PATH);
}

export const ScientLibraryManifest = Schema.Struct({
  formatVersion: Schema.Literal(2),
  libraryId: NonEmptyString,
  owner: Schema.Struct({ kind: Schema.Literal("user") }),
  createdAt: NonEmptyString,
});
export type ScientLibraryManifest = typeof ScientLibraryManifest.Type;

export const ScientLibraryInstance = Schema.Struct({
  instanceId: NonEmptyString,
  projectId: NonEmptyString,
  /** Canonical real path of this checkout on this computer. */
  path: NonEmptyString,
  registeredAt: NonEmptyString,
});
export type ScientLibraryInstance = typeof ScientLibraryInstance.Type;

const ScientLibraryInstances = Schema.Struct({
  formatVersion: Schema.Literal(1),
  instances: Schema.Array(ScientLibraryInstance),
});

async function readManifestFile(root: string): Promise<ScientLibraryManifest | null> {
  const filePath = NodePath.join(root, SCIENT_LIBRARY_MANIFEST_FILE);
  const state = await snapshot(filePath);
  if (state === "missing") return null;
  if (state !== "file") throw new Error(`${SCIENT_LIBRARY_MANIFEST_FILE} is not a safe regular file.`);
  return readBoundedJson(filePath, MAX_MANIFEST_BYTES, ScientLibraryManifest);
}

/** Reads `library.json`. A missing one means the library was never created at this root. */
export async function readScientLibraryManifest(root: string): Promise<ScientLibraryManifest> {
  const manifest = await readManifestFile(await NodeFSP.realpath(root));
  if (!manifest) throw new Error("No Scient library exists at this location.");
  return manifest;
}

/**
 * Creates the library folder and its `library.json` once; later calls return the existing one.
 * The manifest is published with an exclusive create, so two processes agree on one library ID.
 */
export async function ensureScientLibrary(root: string): Promise<ScientLibraryManifest> {
  await ensureDirectory(root);
  const canonicalRoot = await NodeFSP.realpath(root);
  const existing = await readManifestFile(canonicalRoot);
  if (existing) return existing;
  const manifest: ScientLibraryManifest = {
    formatVersion: 2,
    libraryId: `library_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
    owner: { kind: "user" },
    createdAt: new Date().toISOString(),
  };
  const filePath = NodePath.join(canonicalRoot, SCIENT_LIBRARY_MANIFEST_FILE);
  if (await atomicCreateJson(filePath, manifest, MAX_MANIFEST_BYTES)) return manifest;
  return readScientLibraryManifest(canonicalRoot);
}

async function readInstances(root: string): Promise<ReadonlyArray<ScientLibraryInstance>> {
  const filePath = NodePath.join(root, SCIENT_LIBRARY_INSTANCES_FILE);
  const state = await snapshot(filePath);
  if (state === "missing") return [];
  if (state !== "file") throw new Error(`${SCIENT_LIBRARY_INSTANCES_FILE} is not a safe regular file.`);
  return (await readBoundedJson(filePath, MAX_INSTANCES_BYTES, ScientLibraryInstances)).instances;
}

/** This computer's project checkouts known to the library. */
export async function listScientLibraryInstances(
  library: ScientLibraryLocation,
): Promise<ReadonlyArray<ScientLibraryInstance>> {
  return readInstances(await NodeFSP.realpath(library.root));
}

/**
 * The checkout instance for a project folder on this computer, registered on first use. A copy or
 * a moved folder is a new instance: the key is the project ID and the folder's canonical path.
 * Entries are never dropped here; the move (5d) decides when an old checkout is gone for good,
 * because an unattached drive looks the same as a deleted folder.
 */
export async function registerScientLibraryInstance(input: {
  readonly library: ScientLibraryLocation;
  readonly projectId: string;
  readonly projectRoot: string;
}): Promise<ScientLibraryInstance> {
  const root = await NodeFSP.realpath(input.library.root);
  const projectPath = await NodeFSP.realpath(input.projectRoot);
  return withScientLibraryLock(root, async () => {
    const instances = await readInstances(root);
    const existing = instances.find(
      (instance) => instance.projectId === input.projectId && instance.path === projectPath,
    );
    if (existing) return existing;
    const instance: ScientLibraryInstance = {
      instanceId: `instance_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      projectId: input.projectId,
      path: projectPath,
      registeredAt: new Date().toISOString(),
    };
    await atomicWriteJson(
      NodePath.join(root, SCIENT_LIBRARY_INSTANCES_FILE),
      { formatVersion: 1, instances: [...instances, instance] },
      MAX_INSTANCES_BYTES,
    );
    return instance;
  });
}
