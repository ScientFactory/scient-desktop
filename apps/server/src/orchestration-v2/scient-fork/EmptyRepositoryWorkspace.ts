import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitWorkflow from "../../git/GitWorkflowService.ts";
import type * as ProjectService from "../../project/ProjectService.ts";

type BranchSources = Pick<
  GitWorkflow.GitWorkflowService["Service"],
  "hasCommit" | "listLocalBranchNames" | "resolvePrimaryRemoteName"
>;

// GitVcsDriver.resolvePrimaryRemoteName's refusal; any other failure is not proof of no remote.
const NO_REMOTE_DETAIL = "No git remote is configured for this repository.";

/**
 * A repository with no commit at HEAD or at the requested base, no local branch and no
 * remote has nothing a worktree could start from. Unreadable state counts as "has one",
 * leaving the diagnosis to worktree provisioning.
 */
export const hasNothingToBranchFrom = Effect.fn("ScientEmptyRepository.hasNothingToBranchFrom")(
  function* (git: BranchSources, cwd: string, baseRef?: string) {
    if (yield* git.hasCommit({ cwd, refName: "HEAD" })) return false;
    // `:/text` searches commits rather than naming a ref, so it is left to Git.
    if (baseRef !== undefined && baseRef.startsWith(":")) return false;
    // `git worktree add` reads `-` as the previous checkout.
    const requested = baseRef === "-" ? "@{-1}" : baseRef;
    if (requested !== undefined && (yield* git.hasCommit({ cwd, refName: requested })))
      return false;
    if ((yield* git.listLocalBranchNames(cwd)).length > 0) return false;
    return yield* git.resolvePrimaryRemoteName(cwd).pipe(
      Effect.as(false),
      Effect.catchTags({
        GitCommandError: (error) => Effect.succeed(error.detail === NO_REMOTE_DETAIL),
      }),
    );
  },
  Effect.orElseSucceed(() => false),
);

/** T3's non-Git check, extended to repositories with nothing to branch from. */
export const makeCannotHoldWorktree = (dependencies: {
  readonly isNonGitProject: (projectId: ProjectId) => Effect.Effect<boolean>;
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getById">;
  readonly git: BranchSources;
}) =>
  Effect.fn("ScientEmptyRepository.cannotHoldWorktree")(function* (
    projectId: ProjectId,
    baseRef?: string,
  ) {
    if (yield* dependencies.isNonGitProject(projectId)) return true;
    const project = yield* dependencies.projects
      .getById(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return false;
    return yield* hasNothingToBranchFrom(dependencies.git, project.value.workspaceRoot, baseRef);
  });
