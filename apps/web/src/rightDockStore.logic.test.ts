import { describe, expect, it } from "vitest";

import {
  RIGHT_DOCK_PANE_KINDS,
  SINGLETON_PANE_KINDS,
  closePaneInState,
  createDefaultRightDockState,
  filterAddableRightDockPaneKinds,
  isRightDockPaneKind,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  sanitizeRightDockThreadState,
  setDockOpenInState,
  toggleRightDockInState,
  updatePaneInState,
} from "./rightDockStore.logic";

describe("toggleRightDockInState", () => {
  it("opens the empty surface chooser when the dock has never had a pane", () => {
    const state = toggleRightDockInState(createDefaultRightDockState());

    expect(state.open).toBe(true);
    expect(state.activePaneId).toBeNull();
    expect(state.panes).toEqual([]);
  });

  it("closes the dock without discarding its panes or active tab", () => {
    const openState = openPaneInState(
      openPaneInState(createDefaultRightDockState(), {
        paneId: "browser-1",
        kind: "browser",
      }),
      { paneId: "file-1", kind: "file", filePath: "notes.md" },
    );

    const state = toggleRightDockInState(openState);

    expect(state.open).toBe(false);
    expect(state.activePaneId).toBe("file-1");
    expect(state.panes).toBe(openState.panes);
  });

  it("reopens the retained active tab without creating another pane", () => {
    const closedState = {
      ...openPaneInState(
        openPaneInState(createDefaultRightDockState(), {
          paneId: "browser-1",
          kind: "browser" as const,
        }),
        { paneId: "file-1", kind: "file" as const, filePath: "notes.md" },
      ),
      open: false,
    };

    const state = toggleRightDockInState(closedState);

    expect(state.open).toBe(true);
    expect(state.activePaneId).toBe("file-1");
    expect(state.panes).toBe(closedState.panes);
  });

  it("repairs a stale active-tab reference when reopening", () => {
    const closedState = {
      ...openPaneInState(createDefaultRightDockState(), {
        paneId: "browser-1",
        kind: "browser" as const,
      }),
      open: false,
      activePaneId: "missing",
    };

    const state = toggleRightDockInState(closedState);

    expect(state.open).toBe(true);
    expect(state.activePaneId).toBe("browser-1");
    expect(state.panes).toBe(closedState.panes);
  });
});

describe("RIGHT_DOCK_PANE_KINDS (single source of truth)", () => {
  it("lists every supported kind", () => {
    expect([...RIGHT_DOCK_PANE_KINDS]).toEqual([
      "browser",
      "diff",
      "explorer",
      "file",
      "terminal",
      "sidechat",
      "git",
      "pullRequest",
    ]);
  });

  it("derives singletons as every kind except the multi-instance ones", () => {
    for (const kind of RIGHT_DOCK_PANE_KINDS) {
      expect(SINGLETON_PANE_KINDS.has(kind)).toBe(kind !== "sidechat" && kind !== "file");
    }
  });
});

describe("filterAddableRightDockPaneKinds", () => {
  it("removes existing singleton panels from the Add panel menu", () => {
    const state = openPaneInState(
      openPaneInState(createDefaultRightDockState(), {
        paneId: "browser-1",
        kind: "browser",
      }),
      { paneId: "terminal-1", kind: "terminal" },
    );

    expect(
      filterAddableRightDockPaneKinds(state, ["browser", "diff", "terminal", "sidechat"]),
    ).toEqual(["diff", "sidechat"]);
  });

  it("keeps multi-instance panel kinds available", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "side-1",
      kind: "sidechat",
    });

    expect(filterAddableRightDockPaneKinds(state, ["sidechat", "file"])).toEqual([
      "sidechat",
      "file",
    ]);
  });
});

describe("isRightDockPaneKind", () => {
  it("accepts the known pane kinds", () => {
    for (const kind of [
      "browser",
      "diff",
      "explorer",
      "file",
      "terminal",
      "sidechat",
      "git",
      "pullRequest",
    ]) {
      expect(isRightDockPaneKind(kind)).toBe(true);
    }
  });

  it("rejects unknown or malformed kinds", () => {
    expect(isRightDockPaneKind("plan")).toBe(false);
    expect(isRightDockPaneKind(undefined)).toBe(false);
    expect(isRightDockPaneKind(null)).toBe(false);
    expect(isRightDockPaneKind(42)).toBe(false);
  });
});

describe("pull request pane", () => {
  it("reuses the singleton pane and updates its PR identity", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "pr-1",
      kind: "pullRequest",
      pullRequestProjectId: "project-1" as never,
      pullRequestRepository: "acme/one",
      pullRequestNumber: 12,
      pullRequestInitialTab: "summary",
    });
    const reopened = openPaneInState(first, {
      paneId: "pr-2",
      kind: "pullRequest",
      pullRequestProjectId: "project-2" as never,
      pullRequestRepository: "acme/two",
      pullRequestNumber: 24,
      pullRequestInitialTab: "code",
    });
    expect(reopened.panes).toHaveLength(1);
    expect(reopened.activePaneId).toBe("pr-1");
    expect(reopened.panes[0]?.pullRequestProjectId).toBe("project-2");
    expect(reopened.panes[0]?.pullRequestRepository).toBe("acme/two");
    expect(reopened.panes[0]?.pullRequestNumber).toBe(24);
    expect(reopened.panes[0]?.pullRequestInitialTab).toBe("code");
  });

  it("drops a non-integer persisted pull request number", () => {
    const sanitized = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "pr-1",
      panes: [
        {
          paneId: "ignored",
          id: "pr-1",
          kind: "pullRequest",
          pullRequestNumber: 1.5,
        },
      ],
    });
    expect(sanitized.panes[0]?.pullRequestNumber).toBeNull();
  });
});

describe("sanitizeRightDockThreadState", () => {
  it("keeps recognized panes and a valid active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "b",
      panes: [
        { id: "a", kind: "diff", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "b", kind: "terminal", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["a", "b"]);
    expect(state.activePaneId).toBe("b");
    expect(state.open).toBe(true);
  });

  it("drops panes with an unknown kind and repoints the active tab", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
        { id: "keep", kind: "git", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["keep"]);
    expect(state.activePaneId).toBe("keep");
    expect(state.open).toBe(true);
  });

  it("preserves an intentional open-empty dock when no valid panes survive", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "legacy",
      panes: [
        { id: "legacy", kind: "scrabble", threadId: null, diffTurnId: null, diffFilePath: null },
      ],
    });
    expect(state.panes).toEqual([]);
    expect(state.activePaneId).toBeNull();
    expect(state.open).toBe(true);
  });

  it("returns the default state for malformed input", () => {
    expect(sanitizeRightDockThreadState(null)).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
    expect(sanitizeRightDockThreadState({ panes: "nope" })).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
  });

  it("preserves a closed empty persisted dock", () => {
    expect(sanitizeRightDockThreadState({ open: false, activePaneId: null, panes: [] })).toEqual({
      open: false,
      panes: [],
      activePaneId: null,
    });
  });
});

describe("empty dock transitions", () => {
  it("allows the dock to open without creating a pane", () => {
    expect(setDockOpenInState(createDefaultRightDockState(), true)).toEqual({
      open: true,
      panes: [],
      activePaneId: null,
    });
  });

  it("keeps the dock open when its final pane closes", () => {
    const openState = openPaneInState(createDefaultRightDockState(), {
      paneId: "browser-1",
      kind: "browser",
    });
    expect(closePaneInState(openState, "browser-1")).toEqual({
      open: true,
      panes: [],
      activePaneId: null,
    });
  });
});

describe("file panes", () => {
  it("replaces the standalone Explorer with the embedded file surface", () => {
    const explorer = openPaneInState(createDefaultRightDockState(), {
      paneId: "explorer-1",
      kind: "explorer",
    });
    const file = openPaneInState(explorer, {
      paneId: "file-1",
      kind: "file",
      filePath: "src/page.tsx",
    });

    expect(file.panes.map((pane) => pane.kind)).toEqual(["file"]);
    expect(file.activePaneId).toBe("file-1");
  });

  it("opens a file pane carrying the file path", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(state.open).toBe(true);
    expect(state.activePaneId).toBe("f1");
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });

  it("opens another file in a new tab instead of swapping the existing pane", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[0]?.filePath).toBe("src/page.tsx");
    expect(second.panes[1]?.filePath).toBe("README.md");
    expect(second.activePaneId).toBe("f2");
  });

  it("focuses the existing tab when the same file is opened again", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, {
      paneId: "f2",
      kind: "file",
      filePath: "README.md",
    });
    const reopened = openPaneInState(second, {
      paneId: "f3",
      kind: "file",
      filePath: "src/page.tsx",
    });
    expect(reopened.panes).toHaveLength(2);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("reuses an existing empty file pane on a bare open", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
    });
    const reopened = openPaneInState({ ...first, open: false }, { paneId: "f2", kind: "file" });
    expect(reopened.open).toBe(true);
    expect(reopened.panes).toHaveLength(1);
    expect(reopened.activePaneId).toBe("f1");
  });

  it("adds a new empty tab on a bare open when every file pane is occupied", () => {
    const first = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const second = openPaneInState(first, { paneId: "f2", kind: "file" });
    expect(second.panes).toHaveLength(2);
    expect(second.panes[1]?.filePath).toBeNull();
    expect(second.activePaneId).toBe("f2");
  });

  it("updates the file path through updatePaneInState", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      paneId: "f1",
      kind: "file",
      filePath: "src/page.tsx",
    });
    const updated = updatePaneInState(state, "f1", { filePath: "src/other.tsx" });
    expect(updated.panes[0]?.filePath).toBe("src/other.tsx");
    expect(updatePaneInState(updated, "f1", { filePath: "src/other.tsx" })).toBe(updated);
  });

  it("sanitizes persisted file panes, preserving the file path", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "f1",
      panes: [
        {
          id: "f1",
          kind: "file",
          threadId: null,
          diffTurnId: null,
          diffFilePath: null,
          filePath: "src/page.tsx",
        },
      ],
    });
    expect(state.panes[0]?.kind).toBe("file");
    expect(state.panes[0]?.filePath).toBe("src/page.tsx");
  });
});

describe("sanitizeRightDockStateByThreadId", () => {
  it("sanitizes every thread entry and skips undefined values", () => {
    const result = sanitizeRightDockStateByThreadId({
      t1: {
        open: true,
        activePaneId: "x",
        panes: [{ id: "x", kind: "browser", threadId: null, diffTurnId: null, diffFilePath: null }],
      },
      t2: undefined,
    });
    expect(Object.keys(result)).toEqual(["t1"]);
    expect(result.t1?.panes).toHaveLength(1);
  });

  it("returns an empty map for non-object input", () => {
    expect(sanitizeRightDockStateByThreadId(null)).toEqual({});
    expect(sanitizeRightDockStateByThreadId("oops")).toEqual({});
  });
});
