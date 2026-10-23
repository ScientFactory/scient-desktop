import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { pathHasLeftoverDrafts } from "./newDocuments";

const key = { environmentId: EnvironmentId.make("env"), cwd: "/w", relativePath: "paper.tex" };

describe("pathHasLeftoverDrafts", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    localStorage.clear();
    vi.restoreAllMocks();
  }

  it("finds the file's own drafts and Visual's project drafts for it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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

  it("treats unreadable storage as occupied only when asked to", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    localStorage.setItem("x", "y");
    vi.spyOn(localStorage, "key").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(pathHasLeftoverDrafts(key)).toBe(false);
    expect(pathHasLeftoverDrafts(key, true)).toBe(true);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
