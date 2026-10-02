import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatFileLinkResolveInput,
  chatFileOpenPlan,
  linkOpenLocation,
  claimLinkClick,
  clientPlacedLinkPath,
  settleWithin,
  workspaceLocatorAskPath,
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

describe("linkOpenLocation", () => {
  const home = {
    askedPath: "~/notes/today.md",
    clientPath: "/Users/guess/notes/today.md",
    workspaceRoot: "/srv/project",
  };

  it("opens a home-relative link where the environment says its home folder is", () => {
    expect(
      linkOpenLocation({
        ...home,
        resolution: { _tag: "literal", path: path("/home/ada/notes/today.md") },
      }),
    ).toBe("/home/ada/notes/today.md");
    // Inside the workspace it stays a workspace file, so it stays editable,
    // including a workspace folder that really is named `~`.
    expect(
      linkOpenLocation({
        ...home,
        resolution: { _tag: "literal", path: path("/srv/project/notes/today.md") },
      }),
    ).toBe("notes/today.md");
    expect(
      linkOpenLocation({
        ...home,
        resolution: { _tag: "literal", path: path("/srv/project/~/notes/today.md") },
      }),
    ).toBe("~/notes/today.md");
  });

  it("opens a missing home-relative link at the location the environment checked", () => {
    const missingPath = path("/home/ada/notes/today.md");
    for (const resolution of [
      { _tag: "none", missingPath } as const,
      { _tag: "tie", paths: [path("a/today.md"), path("b/today.md")], missingPath } as const,
      { _tag: "incomplete", paths: [], missingPath } as const,
    ]) {
      expect(linkOpenLocation({ ...home, resolution })).toBe("/home/ada/notes/today.md");
    }
  });

  it("keeps the client's placement when the environment did not expand the home folder", () => {
    // Could not be asked.
    expect(linkOpenLocation({ ...home, resolution: null })).toBe(home.clientPath);
    // An environment that predates expansion looks under the workspace.
    expect(
      linkOpenLocation({
        ...home,
        resolution: { _tag: "none", missingPath: path("/srv/project/~/notes/today.md") },
      }),
    ).toBe(home.clientPath);
  });

  it("leaves every other link exactly as the client spelled it", () => {
    expect(
      linkOpenLocation({
        askedPath: "a.md",
        clientPath: "a.md",
        workspaceRoot: "/srv/project",
        resolution: { _tag: "literal", path: path("/srv/project/a.md") },
      }),
    ).toBe("a.md");
  });
});

describe("clientPlacedLinkPath", () => {
  it("guesses a home folder only as a fallback, and leaves other links alone", () => {
    expect(clientPlacedLinkPath("~/notes.md", "/Users/ada/project")).toBe("/Users/ada/notes.md");
    // Inside the workspace the guess is a workspace file.
    expect(clientPlacedLinkPath("~/project/a.md", "/Users/ada/project")).toBe("a.md");
    // No conventional home to guess from: the spelling is kept for the environment.
    expect(clientPlacedLinkPath("~/notes.md", "/srv/project")).toBe("~/notes.md");
    expect(clientPlacedLinkPath("docs/a.md", "/Users/ada/project")).toBe("docs/a.md");
  });
});

describe("workspaceLocatorAskPath", () => {
  it("asks about a workspace ~ folder by its host path, never as the home folder", () => {
    expect(workspaceLocatorAskPath("~/guide.md", "/repo")).toBe("/repo/~/guide.md");
    expect(workspaceLocatorAskPath("~\\guide.md", "C:\\repo")).toBe("C:\\repo\\~\\guide.md");
  });

  it("leaves every other locator as the client spells it", () => {
    expect(workspaceLocatorAskPath("notes/guide.md", "/repo")).toBe("notes/guide.md");
    expect(workspaceLocatorAskPath("/tmp/guide.md", "/repo")).toBe("/tmp/guide.md");
    expect(workspaceLocatorAskPath("~/guide.md", undefined)).toBe("~/guide.md");
  });
});
