import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitCoreShape } from "./Services/GitCore.ts";
import { resolveSourceControlWritingPolicy } from "./sourceControlWritingPolicy.ts";

function makeExecute(stdout = "") {
  return vi.fn<GitCoreShape["execute"]>((input) => {
    const isRepositoryCheck = input.args.join(" ") === "rev-parse --is-inside-work-tree";
    const isHeadCheck = input.args.join(" ") === "rev-parse --verify HEAD";
    return Effect.succeed({
      code: 0,
      stdout: isRepositoryCheck ? "true\n" : isHeadCheck ? "abc123\n" : stdout,
      stderr: "",
    });
  });
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
    ).resolves.toEqual({
      mode: "custom",
      customInstructions: "Use direct wording.",
    });
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

  it("reads only bounded local commit subjects and distinguishes empty from unavailable history", async () => {
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
        args: ["rev-parse", "--is-inside-work-tree"],
        env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        maxOutputBytes: 16,
        timeoutMs: 5000,
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
        env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        maxOutputBytes: 256,
        timeoutMs: 5000,
      }),
    );
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
    const warningMessages: string[] = [];
    const warningLogger = Logger.make(({ message }) => {
      warningMessages.push(String(message));
    });
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
        }).pipe(Effect.provide(Logger.layer([warningLogger], { mergeWithExisting: false }))),
      ),
    ).resolves.toBeUndefined();
    expect(warningMessages).toContain(
      "source-control writing could not read local commit subjects; using standard behavior",
    );

    const emptyMessages: string[] = [];
    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "repository_conventions",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute: makeExecute(""),
        }).pipe(
          Effect.provide(
            Logger.layer(
              [
                Logger.make(({ message }) => {
                  emptyMessages.push(String(message));
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(emptyMessages).toEqual([]);

    const nonzeroHeadExecute = vi.fn<GitCoreShape["execute"]>((input) => {
      const command = input.args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") {
        return Effect.succeed({ code: 0, stdout: "true\n", stderr: "" });
      }
      if (command === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 128, stdout: "", stderr: "invalid HEAD" });
      }
      return Effect.fail({ _tag: "GitCommandError" } as never);
    });
    const nonzeroHeadWarnings: string[] = [];
    await expect(
      Effect.runPromise(
        resolveSourceControlWritingPolicy({
          cwd: "/repo",
          settings: {
            mode: "repository_conventions",
            customInstructions: "",
            followPullRequestTemplate: false,
          },
          execute: nonzeroHeadExecute,
        }).pipe(
          Effect.provide(
            Logger.layer(
              [
                Logger.make(({ message }) => {
                  nonzeroHeadWarnings.push(String(message));
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(nonzeroHeadWarnings).toContain(
      "source-control writing could not read local commit subjects; using standard behavior",
    );
  });

  it("treats a real unborn repository as normal empty history", async () => {
    const repository = mkdtempSync(join(tmpdir(), "synara-unborn-history-"));
    try {
      const initialized = spawnSync("git", ["init"], {
        cwd: repository,
        encoding: "utf8",
      });
      expect(initialized.status).toBe(0);

      const execute = vi.fn<GitCoreShape["execute"]>((input) =>
        Effect.sync(() => {
          const result = spawnSync("git", [...input.args], {
            cwd: input.cwd,
            encoding: "utf8",
            env: { ...process.env, ...input.env },
          });
          return {
            code: result.status ?? 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          };
        }),
      );
      const warningMessages: string[] = [];

      await expect(
        Effect.runPromise(
          resolveSourceControlWritingPolicy({
            cwd: repository,
            settings: {
              mode: "repository_conventions",
              customInstructions: "",
              followPullRequestTemplate: false,
            },
            execute,
          }).pipe(
            Effect.provide(
              Logger.layer(
                [
                  Logger.make(({ message }) => {
                    warningMessages.push(String(message));
                  }),
                ],
                { mergeWithExisting: false },
              ),
            ),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(warningMessages).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["rev-parse", "--verify", "HEAD"] }),
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["symbolic-ref", "--quiet", "HEAD"] }),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
