import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as YAML from "yaml";

// The packaged app's on-disk node_modules follow the workspace lockfile: the stage
// install starts from it, every required peer is a root (electron-builder collects
// only dependencies and optionalDependencies), and anything off-lockfile fails the build.

const LockedVersions = Schema.Record(Schema.String, Schema.String);
const LockedImporterDependencies = Schema.Record(
  Schema.String,
  Schema.Struct({ version: Schema.String }),
);
const WorkspaceLockfile = Schema.Struct({
  importers: Schema.Record(
    Schema.String,
    Schema.Struct({
      dependencies: Schema.optional(LockedImporterDependencies),
      optionalDependencies: Schema.optional(LockedImporterDependencies),
    }),
  ),
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      peerDependencies: Schema.optional(LockedVersions),
      peerDependenciesMeta: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
  snapshots: Schema.Record(
    Schema.String,
    Schema.Struct({
      dependencies: Schema.optional(LockedVersions),
      optionalDependencies: Schema.optional(LockedVersions),
    }),
  ),
});
export type WorkspaceLockfile = typeof WorkspaceLockfile.Type;
const decodeWorkspaceLockfile = Schema.decodeUnknownSync(WorkspaceLockfile);

export class StageLockfileError extends Schema.TaggedError<StageLockfileError>()(
  "StageLockfileError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Staged dependencies do not follow pnpm-lock.yaml: ${this.detail}`;
  }
}

const isStageLockfileError = Schema.is(StageLockfileError);

/** pnpm 11+ writes a package-manager document first; the workspace lockfile is the last one. */
export function parseWorkspaceLockfile(text: string): WorkspaceLockfile {
  const documents = YAML.parseAllDocuments(text);
  return decodeWorkspaceLockfile(documents.at(-1)?.toJS() ?? {});
}

// "1.0.38(zod@4.6.5)" -> "1.0.38"; an npm alias value "string-width@4.2.3" names its own snapshot.
const plainVersion = (locked: string) => locked.split("(")[0]!;
const snapshotKey = (name: string, locked: string) =>
  /^\d/u.test(locked) ? `${name}@${locked}` : locked;
const nameOf = (key: string) => key.slice(0, key.indexOf("@", 1));

/**
 * Every required peer anywhere in the closure of `dependencies`, at its locked version,
 * that is not already a root. Roots resolve through the named importers in order, or as
 * an exact `name@version` the lockfile contains.
 */
export function lockedRequiredPeers(input: {
  readonly lockfile: WorkspaceLockfile;
  readonly importers: ReadonlyArray<string>;
  readonly dependencies: Readonly<Record<string, string>>;
  /** The stage's packageExtensions, which may mark a locked peer optional. */
  readonly packageExtensions?: Readonly<
    Record<string, { readonly peerDependenciesMeta?: Record<string, { optional?: boolean }> }>
  >;
}): Record<string, string> {
  const { lockfile } = input;
  const lockedRoot = (name: string, spec: string) => {
    for (const importer of input.importers) {
      const entry = lockfile.importers[importer];
      const locked = (entry?.dependencies?.[name] ?? entry?.optionalDependencies?.[name])?.version;
      if (locked !== undefined) return snapshotKey(name, locked);
    }
    if (lockfile.snapshots[`${name}@${spec}`]) return `${name}@${spec}`;
    throw new StageLockfileError({ detail: `${name}@${spec} is not in the lockfile.` });
  };

  const peers: Record<string, string> = {};
  const visited = new Set<string>();
  const queue = Object.entries(input.dependencies).map(([name, spec]) => lockedRoot(name, spec));
  for (const key of queue) {
    if (visited.has(key)) continue;
    visited.add(key);
    const snapshot = lockfile.snapshots[key];
    if (!snapshot) throw new StageLockfileError({ detail: `${key} has no lockfile snapshot.` });
    const resolved = { ...snapshot.optionalDependencies, ...snapshot.dependencies };
    for (const [name, locked] of Object.entries(resolved)) queue.push(snapshotKey(name, locked));

    const name = nameOf(key);
    const manifest = lockfile.packages[`${name}@${plainVersion(key.slice(name.length + 1))}`];
    for (const peer of Object.keys(manifest?.peerDependencies ?? {})) {
      const extended = input.packageExtensions?.[name]?.peerDependenciesMeta?.[peer];
      if ((extended ?? manifest?.peerDependenciesMeta?.[peer])?.optional) continue;
      if (Object.hasOwn(input.dependencies, peer)) continue;
      const locked = resolved[peer];
      if (locked === undefined || snapshotKey(peer, locked) === locked)
        throw new StageLockfileError({
          detail: `${key} requires peer ${peer}, locked as ${locked}.`,
        });
      const version = plainVersion(locked);
      if (peers[peer] !== undefined && peers[peer] !== version)
        throw new StageLockfileError({
          detail: `required peer ${peer} is locked at both ${peers[peer]} and ${version}; only one can ship at the top level.`,
        });
      peers[peer] = version;
    }
  }
  return peers;
}

/** Packages the stage installed that the workspace lockfile never resolved. */
export function offLockfilePackages(
  workspace: WorkspaceLockfile,
  stage: WorkspaceLockfile,
): ReadonlyArray<string> {
  return Object.keys(stage.packages).filter((key) => !Object.hasOwn(workspace.packages, key));
}

const readLockfile = Effect.fn("readLockfile")(function* (file: string) {
  const text = yield* (yield* FileSystem.FileSystem).readFileString(file);
  return yield* Effect.try({
    try: () => parseWorkspaceLockfile(text),
    catch: (cause) => new StageLockfileError({ detail: `${file} is unreadable: ${String(cause)}` }),
  });
});

export const readWorkspaceLockfile = Effect.fn("readWorkspaceLockfile")(function* (
  repoRoot: string,
) {
  return yield* readLockfile((yield* Path.Path).join(repoRoot, "pnpm-lock.yaml"));
});

/** A stage's dependencies plus every required peer of their closure, at its locked version. */
export const withLockedRequiredPeers = (input: Parameters<typeof lockedRequiredPeers>[0]) =>
  Effect.try({
    try: () => ({ ...input.dependencies, ...lockedRequiredPeers(input) }),
    catch: (cause) =>
      isStageLockfileError(cause) ? cause : new StageLockfileError({ detail: String(cause) }),
  });

/** Seed a stage with the workspace lockfile, so its install prefers every locked version. */
export const seedStageLockfile = Effect.fn("seedStageLockfile")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
}) {
  const path = yield* Path.Path;
  yield* (yield* FileSystem.FileSystem).copyFile(
    path.join(input.repoRoot, "pnpm-lock.yaml"),
    path.join(input.stageDir, "pnpm-lock.yaml"),
  );
});

/** Refuse a stage whose install resolved anything the workspace lockfile does not pin. */
export const verifyStageFollowsLockfile = Effect.fn("verifyStageFollowsLockfile")(
  function* (input: { readonly workspace: WorkspaceLockfile; readonly stageDir: string }) {
    const stage = yield* readLockfile((yield* Path.Path).join(input.stageDir, "pnpm-lock.yaml"));
    const extra = offLockfilePackages(input.workspace, stage);
    if (extra.length > 0)
      return yield* new StageLockfileError({
        detail: `resolved off-lockfile ${extra.join(", ")}.`,
      });
  },
);
