import { describe, expect, it } from "vitest";

import { resolveNextForkTitle, type ForkTitleThread } from "./forkTitle.ts";

const projectId = "project-1";

const thread = (
  id: string,
  title: string,
  overrides: Partial<ForkTitleThread> = {},
): ForkTitleThread => ({
  id,
  projectId,
  title,
  forkSourceThreadId: null,
  sidechatSourceThreadId: null,
  forkTitleBase: null,
  forkTitleOrdinal: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

describe("resolveNextForkTitle", () => {
  it("numbers the first and repeated forks from the root title", () => {
    const root = thread("root", "Greeting");
    expect(resolveNextForkTitle({ sourceThread: root, threads: [root] })).toEqual({
      title: "Greeting (2)",
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });

    const fork2 = thread("fork-2", "Greeting (2)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });
    expect(resolveNextForkTitle({ sourceThread: root, threads: [root, fork2] })).toEqual({
      title: "Greeting (3)",
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
    });
  });

  it("continues the same family when an automatically named child is forked", () => {
    const root = thread("root", "Greeting");
    const fork2 = thread("fork-2", "Greeting (2)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });
    const fork3 = thread("fork-3", "Greeting (3)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
    });

    expect(resolveNextForkTitle({ sourceThread: fork2, threads: [root, fork2, fork3] })).toEqual({
      title: "Greeting (4)",
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 4,
    });
  });

  it("starts a new naming series after a manual rename", () => {
    const root = thread("root", "Greeting");
    const renamedFork = thread("fork-2", "Experiment", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });
    const experiment2 = thread("experiment-2", "Experiment (2)", {
      forkSourceThreadId: renamedFork.id,
      forkTitleBase: "Experiment",
      forkTitleOrdinal: 2,
    });

    expect(
      resolveNextForkTitle({ sourceThread: renamedFork, threads: [root, renamedFork] }),
    ).toEqual({
      title: "Experiment (2)",
      forkTitleBase: "Experiment",
      forkTitleOrdinal: 2,
    });
    expect(
      resolveNextForkTitle({
        sourceThread: renamedFork,
        threads: [root, renamedFork, experiment2],
      }),
    ).toEqual({
      title: "Experiment (3)",
      forkTitleBase: "Experiment",
      forkTitleOrdinal: 3,
    });
  });

  it("keeps independently renamed siblings in separate families", () => {
    const root = thread("root", "Greeting");
    const renamedA = thread("fork-a", "Experiment", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });
    const renamedB = thread("fork-b", "Experiment", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
    });
    const experimentA2 = thread("experiment-a-2", "Experiment (2)", {
      forkSourceThreadId: renamedA.id,
      forkTitleBase: "Experiment",
      forkTitleOrdinal: 2,
    });

    expect(
      resolveNextForkTitle({
        sourceThread: renamedB,
        threads: [root, renamedA, renamedB, experimentA2],
      }).title,
    ).toBe("Experiment (2)");
  });

  it("starts a new family when a child is manually renamed to its original base", () => {
    const root = thread("root", "Greeting");
    const renamedChild = thread("fork-2", "Greeting", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });
    const originalFork3 = thread("fork-3", "Greeting (3)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
    });

    expect(
      resolveNextForkTitle({
        sourceThread: renamedChild,
        threads: [root, renamedChild, originalFork3],
      }).title,
    ).toBe("Greeting (2)");
  });

  it("preserves natural numeric parentheses as part of the base title", () => {
    const root = thread("root", "Plan (2026)");
    const renamedFork = thread("fork-2", "Experiment (2026)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Plan (2026)",
      forkTitleOrdinal: 2,
    });

    expect(resolveNextForkTitle({ sourceThread: root, threads: [root] }).title).toBe(
      "Plan (2026) (2)",
    );
    expect(
      resolveNextForkTitle({ sourceThread: renamedFork, threads: [root, renamedFork] }).title,
    ).toBe("Experiment (2026) (2)");
  });

  it("counts archived and deleted family members without crossing families or sidechats", () => {
    const root = thread("root", "Greeting");
    const archivedFork = thread("fork-2", "Greeting (2)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
      archivedAt: "2026-07-22T00:00:00.000Z",
    });
    const deletedFork = thread("fork-3", "Greeting (3)", {
      forkSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
      deletedAt: "2026-07-22T01:00:00.000Z",
    });
    const otherRoot = thread("other-root", "Greeting");
    const otherFork = thread("other-fork", "Greeting (20)", {
      forkSourceThreadId: otherRoot.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 20,
    });
    const sidechat = thread("sidechat", "Greeting (99)", {
      forkSourceThreadId: root.id,
      sidechatSourceThreadId: root.id,
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 99,
    });

    expect(
      resolveNextForkTitle({
        sourceThread: root,
        threads: [root, archivedFork, deletedFork, otherRoot, otherFork, sidechat],
      }).title,
    ).toBe("Greeting (4)");
  });
});
