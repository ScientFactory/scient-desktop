import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitCoreShape } from "./Services/GitCore.ts";
import { resolveSourceControlWritingPolicy } from "./sourceControlWritingPolicy.ts";

function makeExecute(stdout = "") {
  return vi.fn<GitCoreShape["execute"]>(() =>
    Effect.succeed({
      code: 0,
      stdout,
      stderr: "",
    }),
  );
}

describe("source control writing policy", () => {
  it("preserves existing behavior without reading repository history in standard mode", async () => {
    const execute = makeExecute("feat: should not be read");

    expect(
      await Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "standard",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute,
        }),
      ),
    ).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves bounded custom and conventional policies without repository reads", async () => {
    const execute = makeExecute();

    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "custom",
            customInstructions: "Use direct wording.",
            followPullRequestTemplate: false,
          },
          execute,
        }),
      ),
    ).resolves.toEqual({ mode: "custom", customInstructions: "Use direct wording." });
    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "conventional_commits",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute,
        }),
      ),
    ).resolves.toEqual({ mode: "conventional_commits" });
    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "custom",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads only bounded local commit subjects and treats unavailable history as standard", async () => {
    const execute = makeExecute(
      `${"a".repeat(200)}\nfeat: add search\nfeat: add search\nsubject\u0000with-control\n`,
    );
    const policy = await Effect.runPromise(
      resolveSourceControlWritingPolicy({
        cwd: "/repo",
        settings: {
          mode: "repository_conventions",
          customInstructions: "",
          followPullRequestTemplate: false,
        },
        execute,
      }),
    );

    expect(policy).toEqual({
      mode: "repository_conventions",
      recentCommitSubjects: ["a".repeat(160), "feat: add search", "subjectwith-control"],
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["log", "-n", "20", "--no-merges", "--format=%s"],
        env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        maxOutputBytes: 4096,
        timeoutMs: 5000,
      }),
    );

    const unavailableExecute = vi.fn<GitCoreShape["execute"]>(() =>
      Effect.fail({ _tag: "GitCommandError" } as never),
    );
    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "repository_conventions",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute: unavailableExecute,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
