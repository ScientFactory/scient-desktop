import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatFileLinkResolveInput,
  chatFileOpenPlan,
  claimLinkClick,
  settleWithin,
} from "./chatFileLinkResolution";

const path = EnvironmentFilePath.make;

describe("chatFileLinkResolveInput", () => {
  it("asks the environment about a link in a workspace thread", () => {
    expect(
      chatFileLinkResolveInput({
        linkPath: "reviews/inside.md",
        workspaceRoot: "/Users/me/project",
        changedPaths: ["reviews/a.md", ""],
      }),
    ).toEqual({
      workspaceRoot: "/Users/me/project",
      path: "reviews/inside.md",
      changedPaths: ["reviews/a.md"],
    });
  });

  it("sends no changed files rather than a partial list that could break a tie wrongly", () => {
    const changedPaths = Array.from({ length: 2_001 }, (_, index) => `dir${index}/dup.md`);
    expect(
      chatFileLinkResolveInput({ linkPath: "dup.md", workspaceRoot: "/repo", changedPaths }),
    ).toEqual({ workspaceRoot: "/repo", path: "dup.md", changedPaths: [] });
    expect(
      chatFileLinkResolveInput({
        linkPath: "dup.md",
        workspaceRoot: "/repo",
        changedPaths: changedPaths.slice(0, 2_000),
      })?.changedPaths,
    ).toHaveLength(2_000);
  });

  it("has nothing to ask without a workspace or with a path the environment cannot take", () => {
    const base = { linkPath: "notes.md", changedPaths: [] };
    expect(chatFileLinkResolveInput({ ...base, workspaceRoot: undefined })).toBeNull();
    expect(
      chatFileLinkResolveInput({ ...base, linkPath: "bad\0path.md", workspaceRoot: "/repo" }),
    ).toBeNull();
    expect(
      chatFileLinkResolveInput({ ...base, linkPath: "x".repeat(5_000), workspaceRoot: "/repo" }),
    ).toBeNull();
  });
});

describe("chatFileOpenPlan", () => {
  const missingPath = path("/Users/me/project/reviews/inside.md");

  it("opens the link as written when it exists or the environment could not be asked", () => {
    expect(chatFileOpenPlan({ _tag: "literal", path: missingPath })).toEqual({
      kind: "as-written",
    });
    expect(chatFileOpenPlan(null)).toEqual({ kind: "as-written" });
  });

  it("opens the one file a missing link meant, and remembers what was missing", () => {
    expect(
      chatFileOpenPlan({ _tag: "recovered", path: path("project/reviews/inside.md"), missingPath }),
    ).toEqual({ kind: "resolved", path: "project/reviews/inside.md", missingPath });
  });

  it("never picks a file when there is no single answer", () => {
    const paths = [path("a/dup.md"), path("b/dup.md")];
    expect(chatFileOpenPlan({ _tag: "tie", paths, missingPath })).toEqual({ kind: "missing" });
    expect(chatFileOpenPlan({ _tag: "none", missingPath })).toEqual({ kind: "missing" });
    // An incomplete search found one file, but cannot call it the only one.
    expect(
      chatFileOpenPlan({ _tag: "incomplete", paths: [path("a/dup.md")], missingPath }),
    ).toEqual({ kind: "missing" });
  });
});

describe("settleWithin", () => {
  it("answers with the value when it arrives in time", async () => {
    await expect(settleWithin(Promise.resolve("plan"), 3_000, null)).resolves.toBe("plan");
  });

  it("answers with the fallback when the connection stalls, so the click is not swallowed", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Promise<string>(() => {});
      const settled = settleWithin(stalled, 3_000, null);
      let answer: string | null | undefined;
      void settled.then((value) => {
        answer = value;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(answer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed request like a stalled one", async () => {
    await expect(
      settleWithin(Promise.reject(new Error("offline")), 3_000, null),
    ).resolves.toBeNull();
  });
});

describe("claimLinkClick", () => {
  const makeClicks = () => {
    let sequence = 0;
    let revision = 0;
    return {
      claimLatest: () => {
        sequence += 1;
        const claimed = sequence;
        return () => claimed === sequence;
      },
      readUserActionRevision: () => revision,
      userActs: () => {
        revision += 1;
      },
    };
  };

  it("stays current while nothing else happens", () => {
    const clicks = makeClicks();
    expect(claimLinkClick(clicks)()).toBe(true);
  });

  it("is superseded by a newer link click", () => {
    const clicks = makeClicks();
    const first = claimLinkClick(clicks);
    const second = claimLinkClick(clicks);
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("is superseded by anything the user does in the panel meanwhile", () => {
    const clicks = makeClicks();
    const click = claimLinkClick(clicks);
    clicks.userActs();
    expect(click()).toBe(false);
  });
});
