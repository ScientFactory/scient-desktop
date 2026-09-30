import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chatFileLinkResolveInput, chatFileOpenPlan } from "./chatFileLinkResolution";

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
