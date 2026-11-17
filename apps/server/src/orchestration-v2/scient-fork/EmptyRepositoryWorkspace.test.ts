import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { hasNothingToBranchFrom } from "./EmptyRepositoryWorkspace.ts";

const remoteLookupFailure = (detail: string) =>
  new GitCommandError({
    operation: "GitVcsDriver.resolvePrimaryRemoteName",
    command: "git remote",
    cwd: "/repo",
    detail,
  });

const emptyRepository = (remote: Effect.Effect<string, GitCommandError>) => ({
  hasCommit: () => Effect.succeed(false),
  listLocalBranchNames: () => Effect.succeed([]),
  resolvePrimaryRemoteName: () => remote,
});

it.effect("counts only a confirmed missing remote as nothing to branch from", () =>
  Effect.gen(function* () {
    assert.isTrue(
      yield* hasNothingToBranchFrom(
        emptyRepository(
          Effect.fail(remoteLookupFailure("No git remote is configured for this repository.")),
        ),
        "/repo",
      ),
    );
    // A failed lookup may hide a usable remote, so the worktree path keeps the request.
    assert.isFalse(
      yield* hasNothingToBranchFrom(
        emptyRepository(Effect.fail(remoteLookupFailure("fatal: unable to read config"))),
        "/repo",
      ),
    );
  }),
);
