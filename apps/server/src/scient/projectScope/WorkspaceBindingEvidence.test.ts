// @effect-diagnostics nodeBuiltinImport:off -- Live boundary tests use git without a shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { describe, expect, it } from "@effect/vitest";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  WorkspaceBindingEvidence,
  layer as workspaceBindingEvidenceLayer,
} from "./WorkspaceBindingEvidence.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => execFileAsync("git", ["-C", cwd, ...args]));

const vcsRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

const repositoryEvidenceLayer = Layer.merge(
  RepositoryIdentityResolver.layer,
  vcsRegistryLayer,
).pipe(Layer.provide(NodeServices.layer));

const liveLayer = workspaceBindingEvidenceLayer.pipe(
  Layer.provide(repositoryEvidenceLayer),
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.merge(liveLayer, NodeServices.layer);

describe("WorkspaceBindingEvidence", () => {
  for (const failure of [
    "probe",
    "remotes",
    "canonical-path",
    "truncated",
    "invalid-utf8",
  ] as const) {
    it.effect(
      `does not publish absent repository evidence after ${failure} failure and recovers uncached`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-evidence-failure-" });
          yield* git(root, ["init"]);
          yield* git(root, [
            "remote",
            "add",
            "origin",
            "https://github.com/ScientFactory/fixture.git",
          ]);
          const process = yield* VcsProcess.VcsProcess;
          let fail = false;
          const injected = VcsProcess.VcsProcess.of({
            run: (input) =>
              Effect.gen(function* () {
                if (
                  fail &&
                  ((failure === "probe" &&
                    input.operation === "ScientWorkspace.inspectRepository") ||
                    (failure === "remotes" && input.operation === "ScientWorkspace.inspectRemotes"))
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
                if (
                  failure === "invalid-utf8" &&
                  input.operation === "ScientWorkspace.inspectRemotes"
                )
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
        }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    );
  }
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
