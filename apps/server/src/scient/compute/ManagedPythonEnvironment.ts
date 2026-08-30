// @effect-diagnostics nodeBuiltinImport:off -- this is the app-private managed Python filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ComputeProjectId,
  ComputeToolkitId,
  type ComputeToolkitId as ComputeToolkitIdType,
} from "@scientfactory/compute";
import * as Schema from "effect/Schema";

const ManagedPythonGeneration = Schema.Struct({
  generationId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  root: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  executableRelativePath: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  toolkitIds: Schema.Array(ComputeToolkitId).check(Schema.isMaxLength(64)),
  activatedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ManagedPythonGeneration = typeof ManagedPythonGeneration.Type;

export const ManagedPythonEnvironmentRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: ComputeProjectId,
  active: ManagedPythonGeneration,
  previous: Schema.NullOr(ManagedPythonGeneration),
});
export type ManagedPythonEnvironmentRecord = typeof ManagedPythonEnvironmentRecord.Type;

export interface ManagedPythonEnvironmentStatus {
  readonly record: ManagedPythonEnvironmentRecord;
  readonly executable: string;
}

export type ManagedPythonEnvironmentFailureReason =
  | "invalid-request"
  | "cancelled"
  | "provision-failed"
  | "verification-failed"
  | "activation-failed"
  | "remove-failed";

export class ManagedPythonEnvironmentError extends Error {
  readonly reason: ManagedPythonEnvironmentFailureReason;

  constructor(
    reason: ManagedPythonEnvironmentFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedPythonEnvironmentError";
    this.reason = reason;
  }
}

export interface ManagedPythonProvisionInput {
  /** Final, fresh app-owned generation directory. Do not build elsewhere and move a venv. */
  readonly targetRoot: string;
  readonly projectId: ComputeProjectId;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly signal: AbortSignal;
}

export interface ManagedPythonProvisionResult {
  /** Executable location relative to targetRoot, such as `bin/python`. */
  readonly executableRelativePath: string;
}

export interface ManagedPythonVerifyInput {
  readonly executable: string;
  readonly projectId: ComputeProjectId;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly signal: AbortSignal;
}

export interface ManagedPythonEnvironmentDependencies {
  readonly provision: (input: ManagedPythonProvisionInput) => Promise<ManagedPythonProvisionResult>;
  readonly verify: (input: ManagedPythonVerifyInput) => Promise<void>;
  readonly now?: (() => number) | undefined;
  readonly generationId?: (() => string) | undefined;
  readonly commitState?:
    | ((statePath: string, record: ManagedPythonEnvironmentRecord) => Promise<void>)
    | undefined;
  /** Injectable only so removal rollback can be proved without platform-specific permission tricks. */
  readonly removeTree?: ((root: string) => Promise<void>) | undefined;
}

export interface ManagedPythonEnvironmentInstallInput {
  readonly projectId: ComputeProjectId;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly signal: AbortSignal;
}

export interface ManagedPythonEnvironmentPaths {
  readonly managedRoot: string;
  readonly projectRoot: string;
  readonly statePath: string;
}

const decodeRecord = Schema.decodeUnknownSync(ManagedPythonEnvironmentRecord);
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ManagedPythonEnvironmentRecord));

function projectKey(projectId: ComputeProjectId): string {
  return NodeCrypto.createHash("sha256").update(projectId).digest("hex");
}

export function managedPythonEnvironmentPaths(
  computeDir: string,
  projectId: ComputeProjectId,
): ManagedPythonEnvironmentPaths {
  const managedRoot = NodePath.join(computeDir, "environments", "python");
  const projectRoot = NodePath.join(managedRoot, projectKey(projectId));
  return {
    managedRoot,
    projectRoot,
    statePath: NodePath.join(projectRoot, "active.json"),
  };
}

function isContained(root: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

function validGenerationId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function executablePath(root: string, relativePath: string): string | null {
  if (NodePath.isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const candidate = NodePath.resolve(root, relativePath);
  return isContained(root, candidate) && candidate !== NodePath.resolve(root) ? candidate : null;
}

async function defaultCommitState(
  statePath: string,
  record: ManagedPythonEnvironmentRecord,
): Promise<void> {
  const temporary = `${statePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, `${encodeRecord(record)}\n`, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, statePath);
  } catch (cause) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function canonicalGeneration(
  projectRoot: string,
  generation: ManagedPythonGeneration,
): Promise<{ readonly generation: ManagedPythonGeneration; readonly executable: string } | null> {
  if (!isContained(projectRoot, generation.root)) return null;
  if (!NodePath.basename(generation.root).startsWith("generation-")) return null;
  const lexicalExecutable = executablePath(generation.root, generation.executableRelativePath);
  if (lexicalExecutable === null) return null;
  try {
    const canonicalProjectRoot = await NodeFSP.realpath(projectRoot);
    const canonicalRoot = await NodeFSP.realpath(generation.root);
    const canonicalExecutable = await NodeFSP.realpath(lexicalExecutable);
    if (
      !isContained(canonicalProjectRoot, canonicalRoot) ||
      !isContained(canonicalRoot, canonicalExecutable)
    ) {
      return null;
    }
    return { generation, executable: canonicalExecutable };
  } catch {
    return null;
  }
}

async function readRecord(
  paths: ManagedPythonEnvironmentPaths,
  projectId: ComputeProjectId,
): Promise<ManagedPythonEnvironmentRecord | null> {
  try {
    const parsed = decodeRecord(JSON.parse(await NodeFSP.readFile(paths.statePath, "utf8")));
    if (parsed.projectId !== projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readStatus(
  paths: ManagedPythonEnvironmentPaths,
  projectId: ComputeProjectId,
): Promise<ManagedPythonEnvironmentStatus | null> {
  const record = await readRecord(paths, projectId);
  if (record === null) return null;
  const active = await canonicalGeneration(paths.projectRoot, record.active);
  if (active === null) return null;
  const previous =
    record.previous === null ? null : await canonicalGeneration(paths.projectRoot, record.previous);
  return {
    record: {
      ...record,
      previous: previous?.generation ?? null,
    },
    executable: active.executable,
  };
}

/**
 * Transactional activation boundary for app-owned Python environments.
 *
 * The provisioner builds directly in a fresh final generation path because a
 * Python virtual environment may embed absolute paths and cannot safely be
 * built elsewhere and renamed. Nothing discovers that generation until its
 * exact executable passes verification and one atomic state-file replacement
 * names it. A failure or cancellation removes only the unpublished candidate
 * and leaves the previous state untouched.
 */
export function makeManagedPythonEnvironmentManager(
  computeDir: string,
  dependencies: ManagedPythonEnvironmentDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const nextGenerationId = dependencies.generationId ?? (() => NodeCrypto.randomUUID());
  const commitState = dependencies.commitState ?? defaultCommitState;
  const removeTree =
    dependencies.removeTree ??
    ((root: string) => NodeFSP.rm(root, { recursive: true, force: true }));

  // Installs are rare and expensive. One manager-wide gate is intentionally
  // simpler than a keyed lock and prevents cleanup for one request racing an
  // activation for another. We can split it only if measured contention proves
  // that necessary.
  let mutationTail: Promise<void> = Promise.resolve();
  const serialize = async <A>(operation: () => Promise<A>): Promise<A> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const inspect = async (
    projectId: ComputeProjectId,
  ): Promise<ManagedPythonEnvironmentStatus | null> => {
    const paths = managedPythonEnvironmentPaths(computeDir, projectId);
    return await readStatus(paths, projectId);
  };

  const cleanupSuperseded = async (
    paths: ManagedPythonEnvironmentPaths,
    record: ManagedPythonEnvironmentRecord,
  ): Promise<void> => {
    const keep = new Set([
      record.active.root,
      ...(record.previous === null ? [] : [record.previous.root]),
    ]);
    const entries = await NodeFSP.readdir(paths.projectRoot).catch((): string[] => []);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("generation-"))
        .map(async (entry) => {
          const candidate = NodePath.join(paths.projectRoot, entry);
          if (!keep.has(candidate)) {
            await NodeFSP.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
          }
        }),
    );
  };

  const install = (input: ManagedPythonEnvironmentInstallInput) => {
    const toolkitIds = [...input.toolkitIds];
    return serialize(async () => {
      if (input.signal.aborted) {
        throw new ManagedPythonEnvironmentError(
          "cancelled",
          "The managed Python setup was cancelled before it started.",
        );
      }
      if (toolkitIds.length === 0 || new Set(toolkitIds).size !== toolkitIds.length) {
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "Choose at least one distinct Toolkit for the managed Python environment.",
        );
      }

      const paths = managedPythonEnvironmentPaths(computeDir, input.projectId);
      await NodeFSP.mkdir(paths.projectRoot, { recursive: true, mode: 0o700 });
      const generationId = nextGenerationId();
      if (!validGenerationId(generationId)) {
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "The managed Python generation identifier was invalid.",
        );
      }
      const candidateRoot = NodePath.join(paths.projectRoot, `generation-${generationId}`);
      await NodeFSP.mkdir(candidateRoot, { recursive: false, mode: 0o700 }).catch((cause) => {
        throw new ManagedPythonEnvironmentError(
          "provision-failed",
          "Scient could not prepare a fresh managed Python generation.",
          { cause },
        );
      });

      let committed = false;
      try {
        const provisioned = await dependencies
          .provision({
            targetRoot: candidateRoot,
            projectId: input.projectId,
            toolkitIds,
            signal: input.signal,
          })
          .catch((cause) => {
            if (input.signal.aborted) {
              throw new ManagedPythonEnvironmentError(
                "cancelled",
                "The managed Python setup was cancelled.",
                { cause },
              );
            }
            throw new ManagedPythonEnvironmentError(
              "provision-failed",
              "Scient could not provision the managed Python environment.",
              { cause },
            );
          });
        if (input.signal.aborted) {
          throw new ManagedPythonEnvironmentError(
            "cancelled",
            "The managed Python setup was cancelled.",
          );
        }

        const lexicalExecutable = executablePath(candidateRoot, provisioned.executableRelativePath);
        if (lexicalExecutable === null) {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The provisioner returned an executable outside its managed generation.",
          );
        }
        const canonicalRoot = await NodeFSP.realpath(candidateRoot).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python generation was not present after provisioning.",
            { cause },
          );
        });
        const canonicalExecutable = await NodeFSP.realpath(lexicalExecutable).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python executable was not present after provisioning.",
            { cause },
          );
        });
        const canonicalProjectRoot = await NodeFSP.realpath(paths.projectRoot).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python project directory was not present after provisioning.",
            { cause },
          );
        });
        if (
          !isContained(canonicalProjectRoot, canonicalRoot) ||
          !isContained(canonicalRoot, canonicalExecutable)
        ) {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python executable escaped its app-owned generation.",
          );
        }

        await dependencies
          .verify({
            executable: canonicalExecutable,
            projectId: input.projectId,
            toolkitIds,
            signal: input.signal,
          })
          .catch((cause) => {
            if (input.signal.aborted) {
              throw new ManagedPythonEnvironmentError(
                "cancelled",
                "The managed Python setup was cancelled before activation.",
                { cause },
              );
            }
            throw new ManagedPythonEnvironmentError(
              "verification-failed",
              "The managed Python environment did not pass verification.",
              { cause },
            );
          });
        if (input.signal.aborted) {
          throw new ManagedPythonEnvironmentError(
            "cancelled",
            "The managed Python setup was cancelled before activation.",
          );
        }

        const existing = await readStatus(paths, input.projectId);
        const active: ManagedPythonGeneration = {
          generationId,
          root: candidateRoot,
          executableRelativePath: provisioned.executableRelativePath,
          toolkitIds,
          activatedAtEpochMs: now(),
        };
        const record: ManagedPythonEnvironmentRecord = {
          schemaVersion: 1,
          projectId: input.projectId,
          active,
          previous: existing?.record.active ?? null,
        };
        await commitState(paths.statePath, record).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "activation-failed",
            "Scient could not activate the verified managed Python environment.",
            { cause },
          );
        });
        committed = true;
        await cleanupSuperseded(paths, record);
        return { record, executable: canonicalExecutable } satisfies ManagedPythonEnvironmentStatus;
      } finally {
        if (!committed) {
          await NodeFSP.rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  };

  const remove = (projectId: ComputeProjectId) =>
    serialize(async () => {
      const paths = managedPythonEnvironmentPaths(computeDir, projectId);
      const present = await NodeFSP.stat(paths.projectRoot).then(
        () => true,
        () => false,
      );
      if (!present) return false;

      const tombstone = NodePath.join(
        paths.managedRoot,
        `${NodePath.basename(paths.projectRoot)}.removing-${NodeCrypto.randomUUID()}`,
      );
      await NodeFSP.rename(paths.projectRoot, tombstone).catch((cause) => {
        throw new ManagedPythonEnvironmentError(
          "remove-failed",
          "Scient could not prepare the managed Python environment for removal.",
          { cause },
        );
      });
      try {
        await removeTree(tombstone);
      } catch (cause) {
        try {
          await NodeFSP.rename(tombstone, paths.projectRoot);
        } catch (rollbackCause) {
          throw new ManagedPythonEnvironmentError(
            "remove-failed",
            "Scient could not remove the managed Python environment or restore it.",
            { cause: new AggregateError([cause, rollbackCause]) },
          );
        }
        throw new ManagedPythonEnvironmentError(
          "remove-failed",
          "Scient could not remove the managed Python environment; the previous environment was restored.",
          { cause },
        );
      }
      return true;
    });

  return { inspect, install, repair: install, remove } as const;
}
