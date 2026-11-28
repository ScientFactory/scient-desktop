import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

/** A registered clean checkout for lifecycle tests that control Git but exercise real file removal. */
export const makeLinkedWorktreeCleanupFixture = Effect.fn("makeLinkedWorktreeCleanupFixture")(
  function* (repositoryRoot: string, worktreePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commonDir = path.join(yield* fs.realPath(repositoryRoot), ".git");
    const adminDir = path.join(commonDir, "worktrees", path.basename(worktreePath));
    const moves: ReadonlyArray<string>[] = [];
    const removals: string[] = [];
    const setBacklink = (cwd: string) =>
      fs.writeFileString(path.join(adminDir, "gitdir"), `${path.join(cwd, ".git")}\n`);

    yield* fs.makeDirectory(worktreePath, { recursive: true });
    yield* fs.makeDirectory(adminDir, { recursive: true });
    yield* fs.writeFileString(path.join(worktreePath, ".git"), `gitdir: ${adminDir}\n`);
    yield* setBacklink(worktreePath);

    const execute: GitVcsDriver["Service"]["execute"] = Effect.fn("LinkedWorktreeFixture.execute")(
      function* ({ args, cwd }) {
        assert.isFalse(args.includes("--force"));
        let stdout = "";
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          stdout = `${commonDir}\n`;
        } else if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
          stdout = `${adminDir}\n`;
        } else if (args[0] === "worktree" && args[1] === "move") {
          const source = args[2]!;
          const target = args[3]!;
          assert.isFalse(yield* fs.exists(target));
          assert.isTrue(yield* fs.exists(path.join(source, ".git")));
          yield* fs.rename(source, target);
          yield* setBacklink(target);
          moves.push(args);
        } else if (args[1] === "worktree" && args[2] === "remove") {
          const target = args.at(-1)!;
          assert.equal(args[0], `--git-dir=${commonDir}`);
          assert.equal(cwd, commonDir);
          assert.isFalse(yield* fs.exists(worktreePath));
          assert.isFalse(yield* fs.exists(target));
          yield* fs.remove(adminDir, { recursive: true });
          removals.push(target);
        } else {
          assert.isTrue(args[0] === "ls-files" || args.includes("status"));
        }
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      Effect.orDie,
    );

    return { execute, moves, removals };
  },
);
