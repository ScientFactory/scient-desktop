import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../../sourceControl/sourceControlDefinitions.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as ServerConfig from "../../config.ts";
import { isGitMissing, isPlainHostScratchDirectory } from "./scratchWorkspace.ts";
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
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  // The project identity keys an SSH alias by the host it points at; evidence must agree.
  const processRunner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);

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
      const readGit = Effect.fn("WorkspaceBindingEvidence.readGit")(function* (
        operation: string,
        args: ReadonlyArray<string>,
      ) {
        const result = yield* git.execute({
          operation,
          cwd: canonicalRoot,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 262_144,
        });
        if (
          result.stdoutTruncated ||
          result.stderrTruncated ||
          result.stdoutInvalidUtf8 ||
          result.stderrInvalidUtf8
        )
          return yield* new WorkspaceBindingResolutionError({
            operation: "inspect-repository-output",
            kind: "repository-inspection-failed",
          });
        return result;
      });
      const [remotes, remoteConfig] = yield* Effect.all(
        [
          readGit("ScientWorkspace.inspectRemotes", ["remote", "-v"]),
          readGit("ScientWorkspace.inspectRemoteConfig", [
            "config",
            "--get-regexp",
            "^remote\\..*\\.url$",
          ]),
        ],
        { concurrency: "unbounded" },
      );
      // `git config --get-regexp` exits 1 when no key matches.
      if (remotes.exitCode !== 0 || (remoteConfig.exitCode !== 0 && remoteConfig.exitCode !== 1))
        return yield* new WorkspaceBindingResolutionError({
          operation: "inspect-remotes",
          kind: "repository-inspection-failed",
        });
      // Binding evidence follows the project identity's configured-URL rule, without the gh
      // repo set-default marker.
      const remote = RepositoryIdentityResolver.pickPrimaryRemote(
        RepositoryIdentityResolver.parseRemoteFetchUrls(
          remotes.stdout,
          RepositoryIdentityResolver.parseConfiguredRemoteUrls(
            remoteConfig.exitCode === 0 ? remoteConfig.stdout : "",
          ),
        ),
        "",
      );
      const transportUrl =
        remote === null
          ? undefined
          : RepositoryIdentityResolver.parseRemoteFetchUrls(remotes.stdout).get(remote.remoteName);
      const keyUrlOf = (remoteUrl: string) =>
        Option.isNone(processRunner)
          ? Effect.succeed(remoteUrl)
          : RepositoryIdentityResolver.sshResolvedRemoteUrl(remoteUrl).pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner.value),
            );
      const keyUrl = remote === null ? undefined : yield* keyUrlOf(remote.remoteUrl);
      const identity =
        remote && keyUrl !== undefined
          ? RepositoryIdentityResolver.buildRepositoryIdentity({
              ...remote,
              keyUrl,
              originUrl: undefined,
              originKeyUrl: undefined,
              rootPath,
            })
          : null;
      const transportCanonicalKey =
        identity === null || transportUrl === undefined || transportUrl === remote?.remoteUrl
          ? undefined
          : sourceControlDefinitions.repositoryKeyFromRemote(yield* keyUrlOf(transportUrl));
      return {
        worktreeIdentity: { kind: "git" as const, rootPath, metadataPath },
        repositoryIdentity: identity
          ? {
              canonicalKey: identity.canonicalKey,
              source: identity.locator.source,
              remoteName: identity.locator.remoteName,
              ...(transportCanonicalKey !== undefined &&
              transportCanonicalKey !== identity.canonicalKey
                ? { transportCanonicalKey }
                : {}),
            }
          : null,
      };
    }).pipe(
      Effect.catchIf(isGitMissing, (cause) =>
        Effect.gen(function* () {
          if (
            Option.isSome(config) &&
            (yield* isPlainHostScratchDirectory(config.value, canonicalRoot).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ))
          ) {
            return null;
          }
          return yield* cause;
        }),
      ),
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
