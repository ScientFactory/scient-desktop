import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  isKeyboardBrowseHighlight,
  resolveBrowseEnterAction,
  shouldOfferProjectPathCreation,
  shouldOpenNewThreadTargetPicker,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
  type CommandPaletteUiState,
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
describe("linked pull request thread navigation", () => {
  it("keeps archived relations searchable and routes them through the PR environment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const id = ThreadId.make("archived-thread");
    const runThread = vi.fn(async () => {});
    const query = "https://github.com/acme/web/pull/42";
    const linkedThreads = {
      environmentId,
      threads: [
        {
          id,
          projectId: ProjectId.make("project"),
          title: "Completed work",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const state = reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null },
      {
        _tag: "OpenSearch",
        query,
        linkedThreads,
      },
    );
    expect(state.openIntent).toEqual({ kind: "search", query, linkedThreads });
    const items = buildLinkedThreadActionItems({ ...linkedThreads, query, icon: null, runThread });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items)).toEqual(items);
    expect(items[0]?.description).toBe("Archived thread");
    await items[0]?.run();
    expect(runThread).toHaveBeenCalledWith({ environmentId, id });
  });
});
describe("reduceCommandPaletteUiState", () => {
  it("opens PR search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null },
      {
        _tag: "OpenSearch",
        query: "https://github.com/acme/web/pull/7",
      },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "https://github.com/acme/web/pull/7" },
    });
    const second = reduceCommandPaletteUiState(first, {
      _tag: "OpenSearch",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(second.openIntent).toEqual({
      kind: "search",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });
});

describe("shouldOpenNewThreadTargetPicker", () => {
  it("opens only for the multi-project modern sidebar", () => {
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: false,
        projectGroupCount: 2,
      }),
    ).toBe(true);
    expect(
      shouldOpenNewThreadTargetPicker({
        legacySidebarEnabled: true,
        projectGroupCount: 2,
      }),
    ).toBe(false);
  });

  // SCIENT-FORK:START
  it("opens for any number of projects, so Add project is always offered", () => {
    for (const projectGroupCount of [0, 1, 3]) {
      expect(
        shouldOpenNewThreadTargetPicker({ legacySidebarEnabled: false, projectGroupCount }),
      ).toBe(true);
    }
  });
  // SCIENT-FORK:END
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("buildThreadActionItems", () => {
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

  it("orders title matches by recent activity before older prefix matches", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old-prefix"),
        title: "Convex InvalidCursor in Convex threads query",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-title"),
        title: "Disable Convex schema validation",
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-content"),
        title: "Fix schema validation",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "created_at",
      icon: null,
      getContentMatch: (thread) =>
        thread.id === ThreadId.make("recent-content")
          ? { source: "user", snippet: "Please check Convex", query: "convex" }
          : undefined,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "convex",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:recent-title",
      "thread:old-prefix",
      "thread:recent-content",
    ]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
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

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${idThread.id}` }),
    ]);
  });

  it("hides subagent threads but keeps forks", () => {
    const parentId = ThreadId.make("parent");
    const items = buildThreadActionItems({
      threads: [
        makeThread({ id: parentId, title: "Parent" }),
        makeThread({
          id: ThreadId.make("subagent"),
          title: "Subagent",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
        makeThread({
          id: ThreadId.make("fork"),
          title: "Fork",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "fork",
          },
        }),
      ],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });

    expect(items.map((item) => item.value).toSorted()).toEqual(["thread:fork", "thread:parent"]);
  });

  it("ranks word-start title matches above newer mid-word matches", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("mid-word"),
          title: "Fix oauth redirect",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("word-start"),
          title: "Clean up auth tokens",
          updatedAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("branch-word-start"),
          title: "Refactor login",
          branch: "feature/auth-cleanup",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "auth",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:word-start",
      "thread:branch-word-start",
      "thread:mid-word",
    ]);
  });

  it("breaks ties within a match tier by latest user message", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("prefix-stale"),
          title: "Auth refactor",
          updatedAt: "2026-03-20T00:00:00.000Z",
          latestUserMessageAt: "2025-09-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("word-fresh"),
          title: "Fix auth refresh",
          updatedAt: "2026-03-10T00:00:00.000Z",
          latestUserMessageAt: "2026-03-10T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      icon: null,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "auth",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:word-fresh",
      "thread:prefix-stale",
    ]);
  });
});

describe("filterPinnedBrowseEntries", () => {
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

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectTitleById: new Map(),
    sortOrder: "updated_at",
    icon: null,
    runThread: async () => undefined,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
  expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
    "Implementation",
  ]);
});

describe("command palette search return", () => {
  const picker = { addonIcon: null, groups: [] };

  it("does not let a delayed browse result replace text entered after the request", () => {
    const resolve = (current: string) => (current === "~/" ? "/synthetic/home/" : current);
    const initial = createCommandPaletteSearchState("~/");
    expect(reduceCommandPaletteSearchState(initial, { type: "query", query: resolve }).query).toBe(
      "/synthetic/home/",
    );
    const edited = reduceCommandPaletteSearchState(initial, { type: "query", query: "~/new" });
    expect(reduceCommandPaletteSearchState(edited, { type: "query", query: resolve }).query).toBe(
      "~/new",
    );
  });

  it("restores each parent query when backing out of nested pickers", () => {
    let state = createCommandPaletteSearchState(">new thread");
    state = reduceCommandPaletteSearchState(state, { type: "push", view: picker });
    expect(state.query).toBe("");
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "remote project" });
    state = reduceCommandPaletteSearchState(state, {
      type: "push",
      view: { ...picker, initialQuery: "~/" },
    });
    expect(state.query).toBe("~/");

    state = reduceCommandPaletteSearchState(state, { type: "query", query: "" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("remote project");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe(">new thread");
    expect(state.views).toHaveLength(0);
  });

  it("cannot return to an old picker after a new search replaces it", () => {
    let state = reduceCommandPaletteSearchState(createCommandPaletteSearchState("old"), {
      type: "push",
      view: picker,
    });
    state = reduceCommandPaletteSearchState(state, { type: "reset", query: "fresh" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("fresh");
    expect(state.views).toHaveLength(0);
  });
});

describe("returning from file and content search", () => {
  const root: CommandPaletteUiState = { open: true, mode: "command", openIntent: null };
  const query = "https://github.com/acme/web/pull/7";
  const context = {
    query,
    linkedThreadSearch: {
      kind: "search" as const,
      query,
      linkedThreads: {
        environmentId: EnvironmentId.make("remote"),
        threads: [
          {
            id: ThreadId.make("linked-thread"),
            projectId: ProjectId.make("project"),
            title: "Completed work",
            archivedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  it.each(["files", "content"] as const)(
    "Escape from %s restores the query and linked-thread results",
    (mode) => {
      const child = reduceCommandPaletteUiState(root, { _tag: "OpenChildSearch", mode, context });
      expect(child.mode).toBe(mode);
      const returned = reduceCommandPaletteUiState(child, { _tag: "BackToCommand" });
      expect(returned).toEqual({ ...root, restoredSearch: context });
      expect(reduceCommandPaletteUiState(returned, { _tag: "BackToCommand" })).toEqual(returned);
    },
  );

  it("closing a child search discards its return context before reopening", () => {
    const child: CommandPaletteUiState = { ...root, mode: "files", parentSearch: context };
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed).toEqual({ open: false, mode: "files", openIntent: null });
    expect(reduceCommandPaletteUiState(closed, { _tag: "BackToCommand" })).toEqual(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual(root);
  });
});
