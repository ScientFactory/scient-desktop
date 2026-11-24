// @effect-diagnostics nodeBuiltinImport:off -- Live boundary tests use git without a shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { describe, expect, it } from "@effect/vitest";
import {
  VcsProcessTimeoutError,
  VcsProcessSpawnError,
  VcsExecutableUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  WorkspaceBindingEvidence,
  layer as workspaceBindingEvidenceLayer,
} from "./WorkspaceBindingEvidence.ts";
import * as WorkspaceBindingStore from "./WorkspaceBindingStore.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => execFileAsync("git", ["-C", cwd, ...args]));

const vcsRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const repositoryEvidenceLayer = Layer.merge(
  RepositoryIdentityResolver.layer,
  vcsRegistryLayer,
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const liveLayer = workspaceBindingEvidenceLayer.pipe(
  Layer.provide(repositoryEvidenceLayer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const testLayer = Layer.merge(liveLayer, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer));
const bindingLayer = Layer.merge(
  testLayer,
  WorkspaceBindingStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("WorkspaceBindingEvidence", () => {
  it.effect.each(["spawn", "unavailable"] as const)(
    "admits only canonical host-owned Scratch folders without Git (%s)",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-no-git-authority-" });
        const root = path.join(baseDir, "scratch");
        const child = path.join(root, "conversation");
        const nested = path.join(child, "nested");
        const outside = path.join(baseDir, "outside");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.makeDirectory(outside);
        const missing =
          kind === "spawn"
            ? new VcsProcessSpawnError({
                operation: "test",
                cwd: root,
                command: "git",
                cause: PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  syscall: "spawn git",
                }),
              })
            : new VcsExecutableUnavailableError({
                operation: "test",
                cwd: root,
                command: "git",
                kind: "git",
              });
        const fixture = workspaceBindingEvidenceLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
              ServerConfig.layerTest(baseDir, baseDir).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              ),
              Layer.effect(
                VcsDriverRegistry.VcsDriverRegistry,
                VcsDriverRegistry.VcsDriverRegistry.pipe(
                  Effect.map((registry) => ({
                    ...registry,
                    get: (kind) =>
                      registry.get(kind).pipe(
                        Effect.map((driver) => ({
                          ...driver,
                          execute: () => Effect.fail(missing),
                        })),
                      ),
                  })),
                ),
              ).pipe(Layer.provide(vcsRegistryLayer)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const evidence = yield* WorkspaceBindingEvidence;
          for (const directory of [root, child]) {
            const observed = yield* evidence.inspect(directory);
            expect(observed.trustState).toBe("verified");
            expect(observed.worktreeIdentity).toBeNull();
            expect(observed.repositoryIdentity).toBeNull();
          }
          yield* fs.symlink(outside, path.join(root, "escape"));
          for (const directory of [outside, nested, path.join(root, "escape")]) {
            expect((yield* evidence.inspect(directory).pipe(Effect.flip)).kind).toBe(
              "repository-inspection-failed",
            );
          }
          yield* fs.writeFileString(path.join(child, ".git"), "gitdir: /missing");
          expect((yield* evidence.inspect(child).pipe(Effect.flip)).kind).toBe(
            "repository-inspection-failed",
          );
          yield* fs.remove(path.join(child, ".git"));
          yield* fs.symlink(path.join(baseDir, "missing"), path.join(baseDir, ".git"));
          expect((yield* evidence.inspect(child).pipe(Effect.flip)).kind).toBe(
            "repository-inspection-failed",
          );
          yield* fs.remove(path.join(baseDir, ".git"));
          yield* fs.rename(root, path.join(baseDir, "redirected"));
          yield* fs.symlink(path.join(baseDir, "redirected"), root);
          expect(
            (yield* evidence.inspect(path.join(root, "conversation")).pipe(Effect.flip)).kind,
          ).toBe("repository-inspection-failed");
        }).pipe(Effect.provide(fixture));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(
    (
      ["probe", "remotes", "remote-config", "canonical-path", "truncated", "invalid-utf8"] as const
    ).map((failure) => ({
      caseTitle: `does not publish absent repository evidence after ${failure} failure and recovers uncached`,
      failure,
    })),
  )("$caseTitle", ({ failure }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-evidence-failure-" });
      yield* git(root, ["init"]);
      yield* git(root, ["remote", "add", "origin", "https://github.com/ScientFactory/fixture.git"]);
      const process = yield* VcsProcess.VcsProcess;
      let fail = false;
      const injected = VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.gen(function* () {
            if (
              fail &&
              ((failure === "probe" && input.operation === "ScientWorkspace.inspectRepository") ||
                (failure === "remotes" && input.operation === "ScientWorkspace.inspectRemotes") ||
                (failure === "remote-config" &&
                  input.operation === "ScientWorkspace.inspectRemoteConfig"))
            )
              return yield* new VcsProcessTimeoutError({
                operation: input.operation,
                cwd: input.cwd,
                command: input.command,
                timeoutMs: 5_000,
              });
            const result = yield* process.run(input);
            if (!fail) return result;
            if (
              failure === "canonical-path" &&
              input.operation === "ScientWorkspace.inspectRepository"
            )
              return { ...result, stdout: `${root}\n${root}/missing-metadata\n` };
            if (failure === "truncated" && input.operation === "ScientWorkspace.inspectRemotes")
              return { ...result, stdoutTruncated: true };
            if (failure === "invalid-utf8" && input.operation === "ScientWorkspace.inspectRemotes")
              return { ...result, stdoutInvalidUtf8: true };
            return result;
          }),
      });
      const fixture = workspaceBindingEvidenceLayer.pipe(
        Layer.provide(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(Layer.succeed(VcsProcess.VcsProcess, injected)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceBindingEvidence;
        const before = yield* service.inspect(root);
        fail = true;
        const error = yield* service.inspect(root).pipe(Effect.flip);
        expect(error.kind).toBe("repository-inspection-failed");
        fail = false;
        const after = yield* service.inspect(root);
        expect(after.repositoryIdentity).toEqual(before.repositoryIdentity);
        expect(after.worktreeIdentity).toEqual(before.worktreeIdentity);
        expect(after.rootFileSystemIdentity).toEqual(before.rootFileSystemIdentity);
      }).pipe(Effect.provide(fixture));
    }).pipe(
      Effect.provide(
        VcsProcess.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  it.effect("canonicalizes an ordinary folder without writing project metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-ordinary-",
      });
      const evidence = yield* (yield* WorkspaceBindingEvidence).inspect(root);

      expect(evidence.canonicalRoot).toBe(yield* fileSystem.realPath(root));
      expect(evidence.scientProjectId).toBeNull();
      expect(evidence.scientProjectIdentityState).toBe("ordinary");
      expect(evidence.trustState).toBe("verified");
      expect(yield* fileSystem.exists(`${root}/.scient`)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads the portable identity of an initialized Scient project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-initialized-",
      });
      yield* Effect.promise(() => initializeScientProject({ root, title: "Binding test" }));
      const identity = yield* Effect.promise(() => readScientProjectIdentity(root));
      const evidence = yield* (yield* WorkspaceBindingEvidence).inspect(root);

      expect(evidence.scientProjectId).toBe(identity.projectId);
      expect(evidence.scientProjectIdentityState).toBe("initialized");
      expect(evidence.trustState).toBe("verified");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains normalized repository and shared Git metadata evidence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-git-",
      });
      yield* git(root, ["init"]);
      yield* git(root, ["remote", "add", "origin", "git@github.com:ScientFactory/example.git"]);

      const evidence = yield* (yield* WorkspaceBindingEvidence).inspect(root);
      expect(evidence.repositoryIdentity?.canonicalKey).toBe("github.com/scientfactory/example");
      expect(evidence.repositoryIdentity).not.toHaveProperty("remoteUrl");
      expect(evidence.worktreeIdentity?.kind).toBe("git");
      expect(evidence.worktreeIdentity?.rootPath).toBe(yield* fileSystem.realPath(root));
      expect(evidence.worktreeIdentity?.metadataPath).toBe(
        yield* fileSystem.realPath(path.join(root, ".git")),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps whitespace and newlines at the end of repository paths",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-workspace-binding-edge-space-",
        });
        const evidenceService = yield* WorkspaceBindingEvidence;
        // The newline name takes the per-path fallback; the others take the one-spawn answer.
        for (const name of ["repo ", "repo\r", "multi\nline "]) {
          const root = path.join(parent, name);
          const gitDir = path.join(parent, `${name.replace("\n", "")} metadata `);
          const workspace = path.join(root, "analysis");
          yield* fileSystem.makeDirectory(workspace, { recursive: true });
          yield* git(root, ["init", `--separate-git-dir=${gitDir}`]);

          const evidence = yield* evidenceService.inspect(workspace);
          expect(evidence.worktreeIdentity?.rootPath).toBe(yield* fileSystem.realPath(root));
          expect(evidence.worktreeIdentity?.metadataPath).toBe(yield* fileSystem.realPath(gitDir));
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["added", "removed"] as const)(
    "keys the configured remote URL and keeps the binding current when a mirror rewrite is %s",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-workspace-binding-insteadof-",
        });
        yield* git(root, ["init"]);
        yield* git(root, [
          "remote",
          "add",
          "origin",
          "https://github.com/ScientFactory/example.git",
        ]);
        const rewrite = ["url.https://mirror.example.com/.insteadOf", "https://github.com/"];
        if (change === "removed") yield* git(root, ["config", ...rewrite]);

        const evidence = yield* WorkspaceBindingEvidence;
        const store = yield* WorkspaceBindingStore.WorkspaceBindingStore;
        const verify = Effect.fn("test.verify")(function* () {
          const observed = yield* evidence.inspect(root);
          const resolved = yield* store.verifyObserved({
            environmentId: EnvironmentId.make("insteadof-environment"),
            hostProjectId: ProjectId.make("insteadof-project"),
            evidence: observed,
          });
          return { observed, binding: resolved.binding };
        });
        const before = yield* verify();
        if (change === "added") yield* git(root, ["config", ...rewrite]);
        else yield* git(root, ["config", "--unset", rewrite[0]!]);
        const after = yield* verify();

        const [plain, rewritten] = change === "added" ? [before, after] : [after, before];
        expect(plain.observed.repositoryIdentity).toEqual({
          canonicalKey: "github.com/scientfactory/example",
          source: "git-remote",
          remoteName: "origin",
        });
        expect(rewritten.observed.repositoryIdentity?.canonicalKey).toBe(
          "github.com/scientfactory/example",
        );
        expect(rewritten.observed.repositoryIdentity?.transportCanonicalKey).toContain(
          "mirror.example.com",
        );
        expect(after.binding.bindingId).toBe(before.binding.bindingId);
        expect(after.binding.authorityGeneration).toBe(before.binding.authorityGeneration);
        expect(yield* store.assertCurrent(before.binding)).toEqual(after.binding);
      }).pipe(Effect.provide(bindingLayer)),
  );

  it.effect("distinguishes linked worktree roots while proving their shared Git lineage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-linked-worktrees-",
      });
      const mainRoot = path.join(parent, "main");
      const childRoot = path.join(parent, "child");
      yield* fileSystem.makeDirectory(mainRoot);
      yield* git(mainRoot, ["init"]);
      yield* git(mainRoot, ["config", "user.name", "Scient Test"]);
      yield* git(mainRoot, ["config", "user.email", "scient-test@example.invalid"]);
      yield* git(mainRoot, ["remote", "add", "origin", "git@github.com:ScientFactory/example.git"]);
      yield* Effect.promise(() =>
        initializeScientProject({ root: mainRoot, title: "Linked worktree test" }),
      );
      yield* git(mainRoot, ["add", "."]);
      yield* git(mainRoot, ["commit", "-m", "Initialize fixture"]);
      yield* git(mainRoot, ["worktree", "add", "-b", "binding-child", childRoot]);

      const evidenceService = yield* WorkspaceBindingEvidence;
      const main = yield* evidenceService.inspect(mainRoot);
      const child = yield* evidenceService.inspect(childRoot);

      expect(main.scientProjectId).toBe(child.scientProjectId);
      expect(main.worktreeIdentity?.rootPath).not.toBe(child.worktreeIdentity?.rootPath);
      expect(main.worktreeIdentity?.metadataPath).toBe(child.worktreeIdentity?.metadataPath);
      expect(main.repositoryIdentity?.canonicalKey).toBe(child.repositoryIdentity?.canonicalKey);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("observes a symlink replacement as a different canonical workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-symlink-",
      });
      const firstRoot = path.join(parent, "first");
      const secondRoot = path.join(parent, "second");
      const alias = path.join(parent, "active");
      yield* fileSystem.makeDirectory(firstRoot);
      yield* fileSystem.makeDirectory(secondRoot);
      yield* fileSystem.symlink(firstRoot, alias);

      const evidenceService = yield* WorkspaceBindingEvidence;
      const first = yield* evidenceService.inspect(alias);
      yield* fileSystem.remove(alias);
      yield* fileSystem.symlink(secondRoot, alias);
      const second = yield* evidenceService.inspect(alias);

      expect(first.canonicalRoot).toBe(yield* fileSystem.realPath(firstRoot));
      expect(second.canonicalRoot).toBe(yield* fileSystem.realPath(secondRoot));
      expect(second.canonicalRoot).not.toBe(first.canonicalRoot);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("observes a directory replacement at the same canonical path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-root-replacement-",
      });
      const root = path.join(parent, "active");
      const priorRoot = path.join(parent, "prior");
      yield* fileSystem.makeDirectory(root);

      const evidenceService = yield* WorkspaceBindingEvidence;
      const first = yield* evidenceService.inspect(root);
      yield* fileSystem.rename(root, priorRoot);
      yield* fileSystem.makeDirectory(root);
      const second = yield* evidenceService.inspect(root);

      expect(second.canonicalRoot).toBe(first.canonicalRoot);
      if (first.rootFileSystemIdentity === null || second.rootFileSystemIdentity === null) {
        expect(first.rootFileSystemIdentity).toBeNull();
        expect(second.rootFileSystemIdentity).toBeNull();
      } else {
        expect(second.rootFileSystemIdentity).not.toEqual(first.rootFileSystemIdentity);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("quarantines conflicting portable identity state as ambiguous", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-conflict-",
      });
      yield* fileSystem.makeDirectory(path.join(root, ".scient"));
      yield* fileSystem.writeFileString(path.join(root, ".scient", "project.json"), "not json");

      const evidence = yield* (yield* WorkspaceBindingEvidence).inspect(root);
      expect(evidence.scientProjectId).toBeNull();
      expect(evidence.scientProjectIdentityState).toBe("conflicting");
      expect(evidence.trustState).toBe("ambiguous");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when the host workspace no longer exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-workspace-binding-missing-",
      });
      const error = yield* (yield* WorkspaceBindingEvidence)
        .inspect(path.join(parent, "removed"))
        .pipe(Effect.flip);

      expect(error.kind).toBe("workspace-unavailable");
    }).pipe(Effect.provide(testLayer)),
  );
});
