import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeApi from "../nativeApi";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitQueryKeys,
  gitWorkingTreeDiffQueryOptions,
  gitWorkingTreeDiffStatsQueryOptions,
  invalidateGitQueries,
  invalidateGitQueriesForCwds,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  passiveGitStatusQueryOptions,
} from "./gitReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("git query invalidation", () => {
  it("invalidates all git query families for broad refreshes", async () => {
    const queryClient = new QueryClient();
    const cwd = "/repo/all";
    const keys = [
      gitQueryKeys.githubRepository(cwd),
      gitQueryKeys.status(cwd),
      gitQueryKeys.branches(cwd),
      gitQueryKeys.workingTreeDiff(cwd, "workingTree"),
      gitQueryKeys.workingTreeDiffStats(cwd, "workingTree"),
      ["git", "pull-request", cwd, "https://example.test/pr/1"] as const,
    ];

    for (const key of keys) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueries(queryClient);

    for (const key of keys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("invalidates only queries for the affected cwd", async () => {
    const queryClient = new QueryClient();
    const cwdA = "/repo/a";
    const cwdB = "/repo/b";
    const cwdAKeys = [
      gitQueryKeys.githubRepository(cwdA),
      gitQueryKeys.status(cwdA),
      gitQueryKeys.branches(cwdA),
      gitQueryKeys.workingTreeDiff(cwdA, "workingTree"),
      gitQueryKeys.workingTreeDiff(cwdA, "staged"),
      gitQueryKeys.workingTreeDiffStats(cwdA, "staged"),
      ["git", "pull-request", cwdA, "https://example.test/pr/1"] as const,
    ];
    const cwdBKeys = [
      gitQueryKeys.githubRepository(cwdB),
      gitQueryKeys.status(cwdB),
      gitQueryKeys.branches(cwdB),
      gitQueryKeys.workingTreeDiff(cwdB, "workingTree"),
      gitQueryKeys.workingTreeDiffStats(cwdB, "workingTree"),
      ["git", "pull-request", cwdB, "https://example.test/pr/2"] as const,
    ];

    for (const key of [...cwdAKeys, ...cwdBKeys]) {
      queryClient.setQueryData(key, {});
    }

    await invalidateGitQueriesForCwds(queryClient, [cwdA]);

    for (const key of cwdAKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    for (const key of cwdBKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });
});

describe("git working tree diff query options", () => {
  it("accepts a live refetch interval for active diff badges", () => {
    const options = gitWorkingTreeDiffQueryOptions({
      cwd: "/repo/a",
      refetchInterval: GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
    });

    expect(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS).toBe(4_000);
    expect(options.refetchInterval).toBe(GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS);
  });
});

describe("git working tree diff stats query options", () => {
  it("keeps stats under the patch invalidation prefix", () => {
    expect(gitQueryKeys.workingTreeDiffStats("/repo/a", "staged")).toEqual([
      "git",
      "working-tree-diff",
      "/repo/a",
      "staged",
      "stats",
    ]);
  });

  it("routes compact stats requests through the native API", async () => {
    const request = vi.fn().mockResolvedValue({ additions: 2, deletions: 1, fileCount: 1 });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      git: { workingTreeDiffStats: request },
    } as never);
    const options = gitWorkingTreeDiffStatsQueryOptions({ cwd: "/repo/a", scope: "unstaged" });

    await expect(options.queryFn?.({} as never)).resolves.toEqual({
      additions: 2,
      deletions: 1,
      fileCount: 1,
    });
    expect(request).toHaveBeenCalledWith({ cwd: "/repo/a", scope: "unstaged" });
  });

  it("stays disabled without a cwd and preserves request failures", async () => {
    const failure = new Error("stats failed");
    const request = vi.fn().mockRejectedValue(failure);
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      git: { workingTreeDiffStats: request },
    } as never);

    expect(gitWorkingTreeDiffStatsQueryOptions({ cwd: null }).enabled).toBe(false);
    const options = gitWorkingTreeDiffStatsQueryOptions({ cwd: "/repo/a", scope: "branch" });
    await expect(options.queryFn?.({} as never)).rejects.toBe(failure);
  });
});

describe("passive git status query options", () => {
  it("relies on domain invalidation instead of focus or timer polling", () => {
    const options = passiveGitStatusQueryOptions("/repo/a");

    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });
});

describe("git status query options", () => {
  it("can defer status polling until repository discovery completes", () => {
    expect(gitStatusQueryOptions("/repo/a", false).enabled).toBe(false);
    expect(gitStatusQueryOptions("/repo/a", true).enabled).toBe(true);
  });

  it("stays disabled without a cwd even when explicitly enabled", () => {
    expect(gitStatusQueryOptions(null, true).enabled).toBe(false);
  });
});
