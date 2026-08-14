/**
 * Where a Scient-installed LaTeX distribution lives on disk, and how to find
 * out whether one is really there.
 *
 * The installer writes this state and the toolchain probe reads it, so the
 * layout lives here rather than in either of them: neither has to know how the
 * other is wired, and the probe stays free of any dependency on the installer.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { TinyTexManifestRef, resolveTinyTexAsset } from "./tinytexManifest.ts";

/** Written once, atomically, after the unpacked tree is in its final place. */
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

export function managedLatexInstallRoot(input: {
  readonly managedRoot: string;
  readonly version: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): string {
  return input.join(input.managedRoot, `tinytex-${input.version}`);
}

/**
 * An install root outside the managed directory is rejected rather than
 * probed, so a tampered state file cannot point the engine at an arbitrary
 * executable on this computer.
 */
export function isManagedInstallRootContained(root: string, managedRoot: string): boolean {
  const normalizedRoot = root.replaceAll("\\", "/");
  const normalizedManagedRoot = managedRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedRoot.startsWith(`${normalizedManagedRoot}/`);
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
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcessPlatform;
    const asset = resolveTinyTexAsset(platform, yield* TinyTexManifestRef);
    if (asset === null) return null;

    const paths = managedLatexPaths({ latexDir: config.latexDir, join: path.join });
    const contents = yield* fileSystem
      .readFileString(paths.statePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) return null;
    const record = yield* decodeManagedLatexInstallRecord(contents).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (record === null || !isManagedInstallRootContained(record.root, paths.managedRoot)) {
      return null;
    }

    const executable = path.join(record.root, asset.executableRelativePath);
    const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
    return present ? { record, executable } : null;
  },
);
