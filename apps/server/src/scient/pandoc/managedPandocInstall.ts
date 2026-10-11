/**
 * Where the Scient-installed Pandoc lives on disk, and how to find out whether
 * it is really there.
 *
 * Everything Pandoc-related sits under `<stateDir>/pandoc`: the managed
 * installs, their staging area, and the per-conversion scratch directories.
 * Nothing outside that directory is ever written, and no Pandoc found on the
 * computer's PATH is ever used.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { PandocManifestRef, resolvePandocAsset } from "./pandocManifest.ts";

/**
 * Written once, atomically, after the unpacked tree passed its `--version`
 * check. This write is the install's commit point: discovery reads nothing but
 * this file, so a tree it does not name is invisible.
 */
export const ManagedPandocInstallRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String.check(Schema.isNonEmpty()),
  /** The pinned archive digest the tree was unpacked from. */
  sha256: Schema.String.check(Schema.isNonEmpty()),
  installedAtEpochMs: Schema.Number,
  /** Absolute path of the unpacked tree. */
  root: Schema.String.check(Schema.isNonEmpty()),
});
export type ManagedPandocInstallRecord = typeof ManagedPandocInstallRecord.Type;

const ManagedPandocInstallRecordJson = Schema.fromJsonString(ManagedPandocInstallRecord);
export const decodeManagedPandocInstallRecord = Schema.decodeUnknownEffect(
  ManagedPandocInstallRecordJson,
);
export const encodeManagedPandocInstallRecord = Schema.encodeEffect(ManagedPandocInstallRecordJson);

export interface ManagedPandocPaths {
  readonly pandocDir: string;
  readonly managedRoot: string;
  readonly statePath: string;
  readonly stagingRoot: string;
  /** Parent of every conversion's private scratch directory. */
  readonly scratchRoot: string;
}

const MANAGED_PANDOC_STATE_FILE = "managed-state.json";
/** Matches {@link managedPandocInstallRoot}, so cleanup only touches install directories. */
export const MANAGED_PANDOC_INSTALL_DIR_PREFIX = "pandoc-";

export function managedPandocPaths(input: {
  readonly stateDir: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): ManagedPandocPaths {
  const pandocDir = input.join(input.stateDir, "pandoc");
  const managedRoot = input.join(pandocDir, "managed");
  return {
    pandocDir,
    managedRoot,
    statePath: input.join(managedRoot, MANAGED_PANDOC_STATE_FILE),
    // Dot-prefixed so a half-finished install is never mistaken for an install.
    stagingRoot: input.join(managedRoot, ".staging"),
    scratchRoot: input.join(pandocDir, "scratch"),
  };
}

/**
 * One directory per install, suffixed with a value nothing else picks, so an
 * install never writes over — or removes — a tree a running conversion is
 * executing from (Windows would refuse while `pandoc.exe` is loaded).
 */
export function managedPandocInstallRoot(input: {
  readonly managedRoot: string;
  readonly version: string;
  readonly unique: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): string {
  return input.join(
    input.managedRoot,
    `${MANAGED_PANDOC_INSTALL_DIR_PREFIX}${input.version}-${input.unique}`,
  );
}

/**
 * A root outside the managed directory is rejected rather than run, so a
 * tampered state file cannot point Word export at an arbitrary executable.
 */
function isManagedPandocRootContained(input: {
  readonly root: string;
  readonly managedRoot: string;
  readonly resolve: (path: string) => string;
}): boolean {
  const root = input.resolve(input.root).replaceAll("\\", "/");
  const managedRoot = input.resolve(input.managedRoot).replaceAll("\\", "/").replace(/\/$/u, "");
  return root.startsWith(`${managedRoot}/`);
}

export interface ManagedPandocInstall {
  readonly record: ManagedPandocInstallRecord;
  readonly executable: string;
}

/**
 * The managed install this computer can run, or `null`. A record for another
 * pinned release or digest, a root outside the managed directory, or a tree
 * whose executable has been deleted all count as absent, which is what lets
 * the user recover by installing again.
 */
export const readManagedPandocInstall = Effect.fn("scient.pandoc.readManagedPandocInstall")(
  function* (): Effect.fn.Return<
    ManagedPandocInstall | null,
    never,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const manifest = yield* PandocManifestRef;
    const lookup = resolvePandocAsset(
      yield* HostProcess.Platform,
      yield* HostProcess.Architecture,
      manifest,
    );
    if (!lookup.supported) return null;

    const paths = managedPandocPaths({ stateDir: config.stateDir, join: path.join });
    const contents = yield* fileSystem
      .readFileString(paths.statePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) return null;
    const record = yield* decodeManagedPandocInstallRecord(contents).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (
      record === null ||
      record.version !== manifest.version ||
      record.sha256 !== lookup.asset.sha256 ||
      !isManagedPandocRootContained({
        root: record.root,
        managedRoot: paths.managedRoot,
        resolve: path.resolve,
      })
    ) {
      return null;
    }
    const executable = path.join(record.root, lookup.asset.executableRelativePath);
    const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
    return present ? { record, executable } : null;
  },
);
