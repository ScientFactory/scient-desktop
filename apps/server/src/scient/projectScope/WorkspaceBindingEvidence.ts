import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import {
  type ObservedWorkspaceEvidence,
  WorkspaceBindingResolutionError,
} from "./WorkspaceBinding.ts";

export class WorkspaceBindingEvidence extends Context.Service<
  WorkspaceBindingEvidence,
  {
    readonly inspect: (
      workspaceRoot: string,
    ) => Effect.Effect<ObservedWorkspaceEvidence, WorkspaceBindingResolutionError>;
  }
>()("t3/scient/projectScope/WorkspaceBindingEvidence") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsDrivers = yield* VcsDriverRegistry.VcsDriverRegistry;

  const inspect: WorkspaceBindingEvidence["Service"]["inspect"] = Effect.fn(
    "WorkspaceBindingEvidence.inspect",
  )(function* (workspaceRoot) {
    const trimmedRoot = workspaceRoot.trim();
    if (trimmedRoot.length === 0) {
      return yield* new WorkspaceBindingResolutionError({
        operation: "inspect-workspace",
        kind: "workspace-unavailable",
      });
    }
    const requestedRoot = path.resolve(trimmedRoot);
    const canonicalRoot = yield* fileSystem.realPath(requestedRoot).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBindingResolutionError({
            operation: "canonicalize-workspace",
            kind: "workspace-unavailable",
            cause,
          }),
      ),
    );
    const stat = yield* fileSystem.stat(canonicalRoot).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBindingResolutionError({
            operation: "stat-workspace",
            kind: "workspace-unavailable",
            cause,
          }),
      ),
    );
    if (stat.type !== "Directory") {
      return yield* new WorkspaceBindingResolutionError({
        operation: "stat-workspace",
        kind: "workspace-unavailable",
      });
    }
    const rootFileSystemIdentity = Option.match(stat.ino, {
      onNone: () => null,
      onSome: (inode) =>
        String(inode) === "0"
          ? null
          : {
              device: String(stat.dev),
              inode: String(inode),
            },
    });

    const projectInspection = yield* Effect.tryPromise({
      try: () => inspectScientProject(canonicalRoot),
      catch: (cause) =>
        new WorkspaceBindingResolutionError({
          operation: "inspect-scient-project",
          kind: "identity-inspection-failed",
          cause,
        }),
    });
    const scientProjectId =
      projectInspection.state === "initialized"
        ? yield* Effect.tryPromise({
            try: () => readScientProjectIdentity(canonicalRoot),
            catch: (cause) =>
              new WorkspaceBindingResolutionError({
                operation: "read-scient-project-identity",
                kind: "identity-inspection-failed",
                cause,
              }),
          }).pipe(Effect.map((identity) => identity.projectId))
        : null;

    // UI discovery helpers intentionally collapse Git failures to absence and
    // cache those observations. Authority evidence needs the uncached outcome.
    const repository = yield* Effect.gen(function* () {
      const git = yield* vcsDrivers.get("git");
      const detected = yield* git.execute({
        operation: "ScientWorkspace.inspectRepository",
        cwd: canonicalRoot,
        args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      });
      if (
        detected.stdoutTruncated ||
        detected.stderrTruncated ||
        detected.stdoutInvalidUtf8 ||
        detected.stderrInvalidUtf8
      )
        return yield* new WorkspaceBindingResolutionError({
          operation: "inspect-repository-output",
          kind: "repository-inspection-failed",
        });
      if (detected.exitCode !== 0) {
        if (detected.stderr.trim().startsWith("fatal: not a git repository")) return null;
        return yield* new WorkspaceBindingResolutionError({
          operation: "inspect-repository",
          kind: "repository-inspection-failed",
        });
      }
      const parts = detected.stdout.trim().split(/\r?\n/u);
      if (parts.length !== 2 || !parts[0] || !parts[1])
        return yield* new WorkspaceBindingResolutionError({
          operation: "inspect-repository-paths",
          kind: "repository-inspection-failed",
        });
      const rootPath = yield* fileSystem.realPath(path.resolve(parts[0]));
      const metadataPath = yield* fileSystem.realPath(path.resolve(parts[1]));
      const remotes = yield* git.execute({
        operation: "ScientWorkspace.inspectRemotes",
        cwd: canonicalRoot,
        args: ["remote", "-v"],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxOutputBytes: 262_144,
      });
      if (
        remotes.stdoutTruncated ||
        remotes.stderrTruncated ||
        remotes.stdoutInvalidUtf8 ||
        remotes.stderrInvalidUtf8
      )
        return yield* new WorkspaceBindingResolutionError({
          operation: "inspect-repository-output",
          kind: "repository-inspection-failed",
        });
      const remote = RepositoryIdentityResolver.pickPrimaryRemote(
        RepositoryIdentityResolver.parseRemoteFetchUrls(remotes.stdout),
      );
      const identity = remote
        ? RepositoryIdentityResolver.buildRepositoryIdentity({ ...remote, rootPath })
        : null;
      return {
        worktreeIdentity: { kind: "git" as const, rootPath, metadataPath },
        repositoryIdentity: identity
          ? {
              canonicalKey: identity.canonicalKey,
              source: identity.locator.source,
              remoteName: identity.locator.remoteName,
            }
          : null,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBindingResolutionError({
            operation: "inspect-repository",
            kind: "repository-inspection-failed",
            cause,
          }),
      ),
    );
    const repositoryIdentity = repository?.repositoryIdentity ?? null;
    const worktreeIdentity = repository?.worktreeIdentity ?? null;

    return {
      canonicalRoot,
      rootFileSystemIdentity,
      scientProjectId,
      scientProjectIdentityState: projectInspection.state,
      repositoryIdentity,
      worktreeIdentity,
      trustState:
        projectInspection.state === "conflicting" || projectInspection.state === "recoverable"
          ? "ambiguous"
          : "verified",
      observedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });

  return WorkspaceBindingEvidence.of({ inspect });
});

export const layer = Layer.effect(WorkspaceBindingEvidence, make);
