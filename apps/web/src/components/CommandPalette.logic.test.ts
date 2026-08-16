import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  isKeyboardBrowseHighlight,
  resolveBrowseEnterAction,
  shouldOfferProjectPathCreation,
  shouldOpenNewThreadTargetPicker,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("resolveBrowseEnterAction", () => {
  const enter = {
    canSubmitBrowsePath: true,
    forceSubmitCurrentPath: false,
    key: "Enter",
    isComposing: false,
    isPrimaryModifierPressed: false,
    highlightedItemValue: null,
    highlightReason: null,
  } as const;

  it("submits the current folder when no browse row is currently highlighted", () => {
    expect(resolveBrowseEnterAction(enter)).toBe("submit-current-path");
  });

  it("leaves a keyboard browse-row selection to the component library", () => {
    expect(
      resolveBrowseEnterAction({
        ...enter,
        highlightedItemValue: "browse:directory:Projects",
        highlightReason: "keyboard",
      }),
    ).toBe("activate-highlighted");
  });

  it("submits the current folder when a browse row is highlighted by pointer or stale state", () => {
    expect(
      resolveBrowseEnterAction({
        ...enter,
        highlightedItemValue: "browse:up",
        highlightReason: "pointer",
      }),
    ).toBe("submit-current-path");
    expect(
      resolveBrowseEnterAction({
        ...enter,
        highlightedItemValue: "browse:directory:Projects",
        highlightReason: "pointer",
      }),
    ).toBe("submit-current-path");
    expect(
      resolveBrowseEnterAction({
        ...enter,
        highlightedItemValue: "browse:up",
        highlightReason: "none",
      }),
    ).toBe("submit-current-path");
  });

  it("activates .. only after deliberate keyboard highlighting", () => {
    expect(
      resolveBrowseEnterAction({
        ...enter,
        highlightedItemValue: "browse:up",
        highlightReason: "keyboard",
      }),
    ).toBe("activate-highlighted");
  });

  it("lets the modifier submit the current folder instead of the highlighted row", () => {
    expect(
      resolveBrowseEnterAction({
        ...enter,
        isPrimaryModifierPressed: true,
        highlightedItemValue: "browse:up",
        highlightReason: "keyboard",
      }),
    ).toBe("submit-current-path");
  });

  it("submits a new-folder draft even when the picker retained its previous row", () => {
    expect(
      resolveBrowseEnterAction({
        ...enter,
        forceSubmitCurrentPath: true,
        highlightedItemValue: "browse:up",
        highlightReason: "keyboard",
      }),
    ).toBe("submit-current-path");
  });

  it("ignores non-submit and composing keyboard events", () => {
    expect(resolveBrowseEnterAction({ ...enter, key: "ArrowDown" })).toBe("ignore");
    expect(resolveBrowseEnterAction({ ...enter, isComposing: true })).toBe("ignore");
  });
});

describe("isKeyboardBrowseHighlight", () => {
  it("treats only arrow-key browse highlights as deliberate", () => {
    expect(
      isKeyboardBrowseHighlight({
        highlightedItemValue: "browse:up",
        highlightReason: "keyboard",
      }),
    ).toBe(true);
    expect(
      isKeyboardBrowseHighlight({
        highlightedItemValue: "browse:up",
        highlightReason: "pointer",
      }),
    ).toBe(false);
    expect(
      isKeyboardBrowseHighlight({
        highlightedItemValue: "browse:directory:Projects",
        highlightReason: "none",
      }),
    ).toBe(false);
  });
});

describe("shouldOfferProjectPathCreation", () => {
  const confirmedMissingPath = {
    canSubmitBrowsePath: true,
    isBrowsePending: false,
    hasBrowseResult: true,
    query: "~/Projects/New project",
    hasKeyboardBrowseHighlight: false,
    hasTrailingPathSeparator: false,
    exactEntryExists: false,
  } as const;

  it("offers creation only after the containing directory confirms a missing path", () => {
    expect(shouldOfferProjectPathCreation(confirmedMissingPath)).toBe(true);
    expect(
      shouldOfferProjectPathCreation({ ...confirmedMissingPath, exactEntryExists: true }),
    ).toBe(false);
  });

  it("does not label unresolved or navigated directory paths as creation", () => {
    expect(
      shouldOfferProjectPathCreation({ ...confirmedMissingPath, hasBrowseResult: false }),
    ).toBe(false);
    expect(shouldOfferProjectPathCreation({ ...confirmedMissingPath, isBrowsePending: true })).toBe(
      false,
    );
    expect(
      shouldOfferProjectPathCreation({
        ...confirmedMissingPath,
        query: "~/Projects/Existing project/",
        hasTrailingPathSeparator: true,
      }),
    ).toBe(false);
  });
});

describe("browseInputEndPaddingClass", () => {
  it("reserves the widest space for the create action", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: true,
        hasHighlightedBrowseItem: false,
      }),
    ).toContain("pe-38");
  });

  it("reserves space for the wider highlighted-item shortcut", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: false,
        hasHighlightedBrowseItem: true,
      }),
    ).toContain("pe-30");
  });

  it("keeps the compact reserve for the normal add action", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: false,
        hasHighlightedBrowseItem: false,
      }),
    ).toContain("pe-24");
  });
});

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: "ToggleMode",
      mode: "content",
    });
    expect(contentOpen).toEqual({ open: true, mode: "content", openIntent: null });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: "ToggleMode", mode: "content" }),
    ).toEqual({ open: false, mode: "command", openIntent: null });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("resets to command mode for dialog-driven opens and closes", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "command",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

describe("shouldOpenNewThreadTargetPicker", () => {
  it("opens the picker whenever projectless threads are supported", () => {
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: true,
        projectGroupCount: 0,
        supportsProjectlessThreads: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: false,
        projectGroupCount: 1,
        supportsProjectlessThreads: true,
      }),
    ).toBe(true);
  });

  it("preserves the existing multi-project behavior on older servers", () => {
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: false,
        projectGroupCount: 2,
        supportsProjectlessThreads: false,
      }),
    ).toBe(true);
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: true,
        projectGroupCount: 2,
        supportsProjectlessThreads: false,
      }),
    ).toBe(false);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleById: new Map([[PROJECT_ID, "Scient"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("Scient · #feat/search");
  });

  it("prefers renderDescription when provided", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search", worktreePath: "/tmp/wt" })],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      renderDescription: (thread, { projectTitle }) =>
        `${projectTitle}:${thread.branch}:${thread.worktreePath ? "wt" : "local"}`,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("T3 Code:feat/search:wt");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });

  it("keeps the former General Chat term as a search alias for Quick Chat threads", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ projectId: null, title: "Unsorted idea" })],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("Quick chat");
    expect(item?.searchTerms).toContain("general chat");
  });
});

describe("buildBrowseGroups", () => {
  it("waits for asynchronous browse navigation actions", async () => {
    let finishNavigation: (() => void) | undefined;
    const browseTo = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const groups = buildBrowseGroups({
      browseEntries: [{ name: "Downloads", fullPath: "/Users/test/Downloads" }],
      browseQuery: "~/",
      canBrowseUp: false,
      upIcon: null,
      directoryIcon: null,
      browseUp: vi.fn(),
      browseTo,
    });
    const item = groups[0]?.items[0];
    if (!item || item.kind !== "action") {
      throw new Error("Expected a browse action");
    }

    let actionSettled = false;
    const action = item.run().then(() => {
      actionSettled = true;
    });
    await Promise.resolve();

    expect(browseTo).toHaveBeenCalledWith("Downloads");
    expect(actionSettled).toBe(false);

    finishNavigation?.();
    await action;
    expect(actionSettled).toBe(true);
  });
});

describe("filterPinnedBrowseEntries", () => {
  const entries = [
    { name: "repo", fullPath: "/projects/repo" },
    { name: "work", fullPath: "/projects/work" },
  ];

  it("shows sibling folders without losing an existing pinned destination", () => {
    expect(
      filterPinnedBrowseEntries({
        browseEntries: entries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: true,
      }),
    ).toEqual({ visibleEntries: entries, exactEntry: entries[0] });
  });

  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});
