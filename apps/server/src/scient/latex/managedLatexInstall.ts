/**
 * Share managed-install layout between installer and discovery without making the probe depend on
 * installer wiring.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { TinyTexManifestRef, resolveTinyTexAsset } from "./tinytexManifest.ts";
import { latexTexDirectory } from "./latexTexDirectory.ts";

/**
 * Written once, atomically, after the unpacked tree is in place. This write is
 * the install's commit point: discovery reads nothing but this file, so until
 * it names a tree that tree is invisible, and the moment it does the swap has
 * already happened whole.
 */
export const ManagedLatexInstallRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String.check(Schema.isNonEmpty()),
  installedAtEpochMs: Schema.Number,
  /** Absolute path of the unpacked distribution root. */
  root: Schema.String.check(Schema.isNonEmpty()),
});
export type ManagedLatexInstallRecord = typeof ManagedLatexInstallRecord.Type;

const ManagedLatexInstallRecordJson = Schema.fromJsonString(ManagedLatexInstallRecord);

export const decodeManagedLatexInstallRecord = Schema.decodeUnknownEffect(
  ManagedLatexInstallRecordJson,
);
export const encodeManagedLatexInstallRecord = Schema.encodeEffect(ManagedLatexInstallRecordJson);

export interface ManagedLatexInstall {
  readonly record: ManagedLatexInstallRecord;
  /** Absolute path of the engine inside {@link ManagedLatexInstallRecord.root}. */
  readonly executable: string;
}

export interface ManagedLatexPaths {
  readonly managedRoot: string;
  readonly statePath: string;
  readonly stagingRoot: string;
}

export const MANAGED_LATEX_STATE_FILE = "managed-state.json";

export function managedLatexPaths(input: {
  readonly latexDir: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): ManagedLatexPaths {
  const managedRoot = input.join(input.latexDir, "managed");
  return {
    managedRoot,
    statePath: input.join(managedRoot, MANAGED_LATEX_STATE_FILE),
    // Dot-prefixed so a half-finished install is never mistaken for one of the
    // installed version directories beside it.
    stagingRoot: input.join(managedRoot, ".staging"),
  };
}

/**
 * Use a fresh unique directory per install; never overwrite a running engine's tree (Windows locks
 * it). Only atomic managed-state selects current, with old-tree cleanup after commit.
 */
export function managedLatexInstallRoot(input: {
  readonly managedRoot: string;
  readonly version: string;
  readonly unique: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): string {
  return input.join(input.managedRoot, `tinytex-${input.version}-${input.unique}`);
}

/**
 * Resolve paths before containment checks and reject roots outside managed storage without probing.
 * Prefix matching alone would let a tampered state file select arbitrary executables through parent
 * walks.
 */
export function isManagedInstallRootContained(input: {
  readonly root: string;
  readonly managedRoot: string;
  /** `path.resolve`, which is what collapses the `..` segments. */
  readonly resolve: (path: string) => string;
}): boolean {
  const root = input.resolve(input.root).replaceAll("\\", "/");
  const managedRoot = input.resolve(input.managedRoot).replaceAll("\\", "/").replace(/\/$/u, "");
  return root.startsWith(`${managedRoot}/`);
}

/**
 * The managed install this computer can actually run, or `null`. A state file
 * whose tree has been deleted counts as absent, which is what lets the user
 * recover by installing again.
 */
export const readManagedLatexInstall = Effect.fn("scient.latex.readManagedLatexInstall")(
  function* (): Effect.fn.Return<
    ManagedLatexInstall | null,
    never,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const lookup = resolveTinyTexAsset(platform, architecture, yield* TinyTexManifestRef);
    if (!lookup.supported) return null;
    const asset = lookup.asset;

    const paths = managedLatexPaths({ latexDir: yield* latexTexDirectory, join: path.join });
    const contents = yield* fileSystem
      .readFileString(paths.statePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) return null;
    const record = yield* decodeManagedLatexInstallRecord(contents).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (
      record === null ||
      !isManagedInstallRootContained({
        root: record.root,
        managedRoot: paths.managedRoot,
        resolve: path.resolve,
      })
    ) {
      return null;
    }

    const executable = path.join(record.root, asset.executableRelativePath);
    const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
    return present ? { record, executable } : null;
  },
);
