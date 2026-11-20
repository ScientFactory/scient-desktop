import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { defaultWorktreeStrategy } from "./handlers.ts";

const result = (exitCode: number, stdout = "", stderr = "") => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const timedOut = (operation: string, cwd: string) =>
  new GitCommandError({ operation, command: "git", cwd, detail: "Git command timed out." });

const REFUSED = "fatal: detected dubious ownership in repository at '/repo'";
const NOT_A_REPOSITORY = "fatal: not a git repository (or any of the parent directories): .git";
const MISSING_GITDIR = "fatal: not a git repository: /main/.git/worktrees/repo";

const gitAnswering = (
  headProbe:
    | "timeout"
    | "unborn"
    | "missing-object"
    | "commit"
    | "refused"
    | "missing-gitdir"
    | "not-a-repository",
) =>
  Layer.merge(
    // A worktree whose gitdir is gone still has its `.git` file; a plain folder has none.
    FileSystem.layerNoop({
      lstat: (path) =>
        headProbe === "missing-gitdir" && path === "/repo/.git"
          ? Effect.succeed({ type: "File" } as FileSystem.File.Info)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "lstat",
                pathOrDescriptor: path,
              }),
            ),
    }),
    gitDriverAnswering(headProbe),
  );

const gitDriverAnswering = (headProbe: Parameters<typeof gitAnswering>[0]) =>
  Layer.mock(GitVcsDriver.GitVcsDriver)({
    resolveCommit: (input) =>
      headProbe === "commit"
        ? Effect.succeed({ commitSha: "abc123" })
        : Effect.fail(
            headProbe === "timeout"
              ? timedOut("GitVcsDriver.resolveCommit", input.cwd)
              : new GitCommandError({
                  operation: "GitVcsDriver.resolveCommit",
                  command: "git",
                  cwd: input.cwd,
                  detail: "Needed a single revision",
                }),
          ),
    execute: (input) =>
      input.args[0] === "rev-parse"
        ? headProbe === "timeout"
          ? Effect.fail(timedOut(input.operation, input.cwd))
          : Effect.succeed(
              headProbe === "refused"
                ? result(128, "", REFUSED)
                : headProbe === "missing-gitdir"
                  ? result(128, "", MISSING_GITDIR)
                  : headProbe === "not-a-repository"
                    ? result(128, "", NOT_A_REPOSITORY)
                    : // A missing commit object fails only the commit check; HEAD still names it.
                      headProbe === "missing-object"
                      ? result(input.args.at(-1) === "HEAD" ? 0 : 1, "abc123\n")
                      : result(headProbe === "unborn" ? 1 : 0, "abc123\n"),
            )
        : Effect.succeed(result(0, "main\n")),
  });

it.effect("a HEAD probe that never answers refuses the worktree default instead of sharing", () =>
  Effect.gen(function* () {
    const failure = yield* defaultWorktreeStrategy("/repo").pipe(
      Effect.provide(gitAnswering("timeout")),
      Effect.flip,
    );
    assert.equal(failure.code, "orchestration_error");
    assert.include(failure.message, "pass workspaceStrategy");
    // A checkout Git refuses exits 128 like a non-repository, but is no proof of either.
    const refused = yield* defaultWorktreeStrategy("/repo").pipe(
      Effect.provide(gitAnswering("refused")),
      Effect.flip,
    );
    assert.equal(refused.code, "orchestration_error");
    // So does a worktree whose gitdir is gone: Git calls it no repository, but its `.git` remains.
    const missing = yield* defaultWorktreeStrategy("/repo").pipe(
      Effect.provide(gitAnswering("missing-gitdir")),
      Effect.flip,
    );
    assert.equal(missing.code, "orchestration_error");
    assert.include(missing.message, "pass workspaceStrategy");

    // Git's own answer still decides: no commit or no repository stays shared, a branch gets a worktree.
    assert.isUndefined(
      yield* defaultWorktreeStrategy("/repo").pipe(Effect.provide(gitAnswering("unborn"))),
    );
    assert.isUndefined(
      yield* defaultWorktreeStrategy("/repo").pipe(
        Effect.provide(gitAnswering("not-a-repository")),
      ),
    );
    // HEAD is not peeled, so a branch whose tip object is missing still gets its worktree.
    assert.deepEqual(
      yield* defaultWorktreeStrategy("/repo").pipe(Effect.provide(gitAnswering("missing-object"))),
      { type: "worktree", baseRef: "main" },
    );
    assert.deepEqual(
      yield* defaultWorktreeStrategy("/repo").pipe(Effect.provide(gitAnswering("commit"))),
      { type: "worktree", baseRef: "main" },
    );
  }),
);
