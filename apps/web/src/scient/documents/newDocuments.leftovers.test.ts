// @vitest-environment happy-dom
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { pathHasLeftoverDrafts } from "./newDocuments";

const key = { environmentId: EnvironmentId.make("env"), cwd: "/w", relativePath: "paper.tex" };

describe("pathHasLeftoverDrafts", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("finds the file's own drafts and Visual's project drafts for it", () => {
    expect(pathHasLeftoverDrafts(key)).toBe(false);
    localStorage.setItem("scient.latex.field:env\0/w\0paper.tex:title", "{}");
    expect(pathHasLeftoverDrafts(key)).toBe(true);
    localStorage.clear();
    localStorage.setItem(
      "scient:latex-visual-draft:source:env\0/w\0project-visual:paper.tex",
      "{}",
    );
    expect(pathHasLeftoverDrafts(key)).toBe(true);
    expect(pathHasLeftoverDrafts({ ...key, relativePath: "other.tex" })).toBe(false);
  });

  it("treats unreadable storage as occupied only when asked to", () => {
    localStorage.setItem("x", "y");
    vi.spyOn(localStorage, "key").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(pathHasLeftoverDrafts(key)).toBe(false);
    expect(pathHasLeftoverDrafts(key, true)).toBe(true);
  });
});
