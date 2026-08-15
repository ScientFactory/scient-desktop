import { describe, expect, it } from "vite-plus/test";

import { shouldCreateScientThreadInCurrentProject } from "./newThreadTarget";

describe("shouldCreateScientThreadInCurrentProject", () => {
  it("preserves upstream behavior when projectless threads are unavailable", () => {
    expect(
      shouldCreateScientThreadInCurrentProject({
        shiftKey: false,
        projectGroupCount: 1,
        supportsProjectlessThreads: false,
      }),
    ).toBe(true);
    expect(
      shouldCreateScientThreadInCurrentProject({
        shiftKey: false,
        projectGroupCount: 2,
        supportsProjectlessThreads: false,
      }),
    ).toBe(false);
  });

  it("keeps the target picker on a plain click when Quick Chat adds another target", () => {
    expect(
      shouldCreateScientThreadInCurrentProject({
        shiftKey: false,
        projectGroupCount: 1,
        supportsProjectlessThreads: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateScientThreadInCurrentProject({
        shiftKey: true,
        projectGroupCount: 1,
        supportsProjectlessThreads: true,
      }),
    ).toBe(true);
  });

  it("does not claim a current-project action when no project exists", () => {
    expect(
      shouldCreateScientThreadInCurrentProject({
        shiftKey: true,
        projectGroupCount: 0,
        supportsProjectlessThreads: true,
      }),
    ).toBe(false);
  });
});
