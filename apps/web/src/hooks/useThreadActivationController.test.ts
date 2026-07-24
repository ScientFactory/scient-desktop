import { describe, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";
import type { SplitView } from "../splitViewStore";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  waitForDraftNavigationIdle,
} from "../lib/stagedDraftNavigation";
import {
  activateThreadFromSidebarIntent,
  type ThreadActivationControllerInput,
} from "./useThreadActivationController";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeSplitViewFixture(input: {
  id: string;
  sourceThreadId: ThreadId;
  firstThreadId: ThreadId | null;
  secondThreadId: ThreadId | null;
  focusOn: "first" | "second";
}): SplitView {
  const firstId = `${input.id}-pane-first`;
  const secondId = `${input.id}-pane-second`;
  const panel = {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser" as const,
  };
  return {
    id: input.id,
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: PROJECT_ID,
    focusedPaneId: input.focusOn === "first" ? firstId : secondId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    root: {
      kind: "split",
      id: `${input.id}-root`,
      direction: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", id: firstId, threadId: input.firstThreadId, panel },
      second: { kind: "leaf", id: secondId, threadId: input.secondThreadId, panel },
    },
  };
}

function makeControllerInput(
  overrides: Partial<ThreadActivationControllerInput> = {},
): ThreadActivationControllerInput & {
  navigate: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  openChatThreadPage: ReturnType<typeof vi.fn>;
  openSidechatSplit: ReturnType<typeof vi.fn>;
  openTerminalThreadPage: ReturnType<typeof vi.fn>;
  prewarmThreadDetailForIntent: ReturnType<typeof vi.fn>;
  rememberLastThreadRouteNow: ReturnType<typeof vi.fn>;
  setOptimisticActiveThreadId: ReturnType<typeof vi.fn>;
  setSelectionAnchor: ReturnType<typeof vi.fn>;
  setSplitFocusedPane: ReturnType<typeof vi.fn>;
} {
  return {
    activeSplitView: null,
    clearSelection: vi.fn(),
    navigate: vi.fn(),
    openChatThreadPage: vi.fn(),
    openSidechatSplit: vi.fn(() => "split-sidechat"),
    openTerminalThreadPage: vi.fn(),
    prewarmThreadDetailForIntent: vi.fn(),
    rememberLastThreadRouteNow: vi.fn(),
    routeSplitViewId: undefined,
    routeThreadId: THREAD_A,
    selectedThreadCount: 0,
    setOptimisticActiveThreadId: vi.fn(),
    setSelectionAnchor: vi.fn(),
    setSplitFocusedPane: vi.fn(),
    sidebarThreadSummaryById: {
      [THREAD_A]: { id: THREAD_A, projectId: PROJECT_ID, sidechatSourceThreadId: null },
      [THREAD_B]: { id: THREAD_B, projectId: PROJECT_ID, sidechatSourceThreadId: null },
      [THREAD_C]: { id: THREAD_C, projectId: PROJECT_ID, sidechatSourceThreadId: null },
    },
    splitViewsById: {},
    terminalStateByThreadId: {},
    ...overrides,
  } as ThreadActivationControllerInput & {
    navigate: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    openChatThreadPage: ReturnType<typeof vi.fn>;
    openSidechatSplit: ReturnType<typeof vi.fn>;
    openTerminalThreadPage: ReturnType<typeof vi.fn>;
    prewarmThreadDetailForIntent: ReturnType<typeof vi.fn>;
    rememberLastThreadRouteNow: ReturnType<typeof vi.fn>;
    setOptimisticActiveThreadId: ReturnType<typeof vi.fn>;
    setSelectionAnchor: ReturnType<typeof vi.fn>;
    setSplitFocusedPane: ReturnType<typeof vi.fn>;
  };
}

function getFirstNavigateArgs(input: { navigate: ReturnType<typeof vi.fn> }) {
  const [args] = input.navigate.mock.calls[0] ?? [];
  if (!args) {
    throw new Error("Expected navigate to be called");
  }
  return args as {
    params: { threadId: ThreadId };
    search: (previous: { splitViewId?: string; keep?: boolean }) => {
      splitViewId?: string | undefined;
      keep?: boolean;
    };
  };
}

describe("activateThreadFromSidebarIntent", () => {
  it("supersedes a pending new-thread preparation before activating an existing thread", async () => {
    let releasePreparation!: () => void;
    let pendingOwnerWasCurrent = true;
    const pending = runDraftNavigationOnce(
      draftNavigationSlotKey(),
      "delayed-exact-workspace",
      async (ownership) => {
        await new Promise<void>((resolve) => {
          releasePreparation = resolve;
        });
        pendingOwnerWasCurrent = ownership.isCurrent();
        return ownership.isCurrent();
      },
    );
    await Promise.resolve();
    const input = makeControllerInput();

    const activation = activateThreadFromSidebarIntent(input, THREAD_B);
    releasePreparation();

    await activation;
    await expect(pending).resolves.toBe(false);
    expect(pendingOwnerWasCurrent).toBe(false);
    expect(input.openChatThreadPage).toHaveBeenCalledWith(THREAD_B);
    await waitForDraftNavigationIdle(draftNavigationSlotKey());
  });

  it("waits for a blocking preparation before activating an existing thread", async () => {
    let releaseMutation!: () => void;
    const pending = runDraftNavigationOnce(
      draftNavigationSlotKey(),
      "mutating-pr-preparation",
      async () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve;
        }),
      { blocksFollowingOperations: true },
    );
    await Promise.resolve();
    const input = makeControllerInput();

    const activation = activateThreadFromSidebarIntent(input, THREAD_B);
    await Promise.resolve();
    expect(input.openChatThreadPage).not.toHaveBeenCalled();
    expect(input.navigate).not.toHaveBeenCalled();

    releaseMutation();
    await activation;
    await pending;

    expect(input.openChatThreadPage).toHaveBeenCalledWith(THREAD_B);
    expect(input.navigate).toHaveBeenCalledOnce();
  });

  it("focuses a target pane in the active split", async () => {
    const activeSplitView = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const input = makeControllerInput({
      activeSplitView,
      routeSplitViewId: "split-active",
      selectedThreadCount: 1,
    });

    await activateThreadFromSidebarIntent(input, THREAD_B);

    expect(input.prewarmThreadDetailForIntent).toHaveBeenCalledWith(THREAD_B);
    expect(input.clearSelection).toHaveBeenCalledOnce();
    expect(input.setSplitFocusedPane).toHaveBeenCalledWith(
      "split-active",
      "split-active-pane-second",
    );
    expect(input.rememberLastThreadRouteNow).toHaveBeenCalledWith({
      threadId: THREAD_B,
      splitViewId: "split-active",
    });
    expect(getFirstNavigateArgs(input).search({ keep: true })).toEqual({
      keep: true,
      splitViewId: "split-active",
    });
    expect(input.openChatThreadPage).not.toHaveBeenCalled();
  });

  it("exits an active split when the target thread is outside it", async () => {
    const activeSplitView = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const input = makeControllerInput({
      activeSplitView,
      routeSplitViewId: "split-active",
    });

    await activateThreadFromSidebarIntent(input, THREAD_C);

    expect(input.openChatThreadPage).toHaveBeenCalledWith(THREAD_C);
    expect(input.setSplitFocusedPane).not.toHaveBeenCalled();
    expect(getFirstNavigateArgs(input).search({ keep: true, splitViewId: "split-active" })).toEqual(
      {
        keep: true,
        splitViewId: undefined,
      },
    );
  });

  it("restores a persisted split from single-chat mode", async () => {
    const splitView = makeSplitViewFixture({
      id: "split-background",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const input = makeControllerInput({
      activeSplitView: null,
      routeThreadId: THREAD_C,
      splitViewsById: { "split-background": splitView },
    });

    await activateThreadFromSidebarIntent(input, THREAD_B);

    expect(input.setSplitFocusedPane).toHaveBeenCalledWith(
      "split-background",
      "split-background-pane-second",
    );
    expect(input.rememberLastThreadRouteNow).toHaveBeenCalledWith({
      threadId: THREAD_B,
      splitViewId: "split-background",
    });
    expect(getFirstNavigateArgs(input).search({ keep: true })).toEqual({
      keep: true,
      splitViewId: "split-background",
    });
  });

  it("switches between two persisted split pairings without separating them", async () => {
    const firstSplit = makeSplitViewFixture({
      id: "split-first",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const secondSplit = makeSplitViewFixture({
      id: "split-second",
      sourceThreadId: THREAD_C,
      firstThreadId: THREAD_C,
      secondThreadId: THREAD_B,
      focusOn: "first",
    });
    const input = makeControllerInput({
      activeSplitView: firstSplit,
      routeSplitViewId: "split-first",
      routeThreadId: THREAD_A,
      splitViewsById: {
        "split-first": firstSplit,
        "split-second": secondSplit,
      },
    });

    await activateThreadFromSidebarIntent(input, THREAD_C);

    expect(input.setSplitFocusedPane).toHaveBeenCalledWith(
      "split-second",
      "split-second-pane-first",
    );
    expect(input.openChatThreadPage).not.toHaveBeenCalled();
    expect(getFirstNavigateArgs(input).search({ keep: true, splitViewId: "split-first" })).toEqual({
      keep: true,
      splitViewId: "split-second",
    });
  });

  it("does nothing when the current route already targets the same split pane", async () => {
    const activeSplitView = makeSplitViewFixture({
      id: "split-active",
      sourceThreadId: THREAD_A,
      firstThreadId: THREAD_A,
      secondThreadId: THREAD_B,
      focusOn: "second",
    });
    const input = makeControllerInput({
      activeSplitView,
      routeSplitViewId: "split-active",
      routeThreadId: THREAD_B,
    });

    await activateThreadFromSidebarIntent(input, THREAD_B);

    expect(input.navigate).not.toHaveBeenCalled();
    expect(input.setSplitFocusedPane).not.toHaveBeenCalled();
    expect(input.rememberLastThreadRouteNow).not.toHaveBeenCalled();
  });

  it("preserves terminal entry point when opening a single thread", async () => {
    const terminalStateByThreadId = {
      [THREAD_C]: { entryPoint: "terminal" },
    } as unknown as ThreadActivationControllerInput["terminalStateByThreadId"];
    const input = makeControllerInput({
      routeThreadId: THREAD_A,
      terminalStateByThreadId,
    });

    await activateThreadFromSidebarIntent(input, THREAD_C);

    expect(input.openTerminalThreadPage).toHaveBeenCalledWith(THREAD_C);
    expect(input.openChatThreadPage).not.toHaveBeenCalled();
    expect(getFirstNavigateArgs(input).params).toEqual({ threadId: THREAD_C });
  });

  it("opens sidechat rows beside their source thread when no persisted split exists", async () => {
    const input = makeControllerInput({
      routeThreadId: THREAD_A,
      sidebarThreadSummaryById: {
        [THREAD_A]: { id: THREAD_A, projectId: PROJECT_ID, sidechatSourceThreadId: null },
        [THREAD_B]: { id: THREAD_B, projectId: PROJECT_ID, sidechatSourceThreadId: THREAD_A },
      },
    });

    await activateThreadFromSidebarIntent(input, THREAD_B);

    expect(input.openSidechatSplit).toHaveBeenCalledWith({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      sidechatThreadId: THREAD_B,
    });
    expect(input.openChatThreadPage).not.toHaveBeenCalled();
    expect(input.rememberLastThreadRouteNow).toHaveBeenCalledWith({
      threadId: THREAD_B,
      splitViewId: "split-sidechat",
    });
    expect(getFirstNavigateArgs(input).search({ keep: true })).toEqual({
      keep: true,
      splitViewId: "split-sidechat",
    });
  });

  it("opens the active single sidechat as a split when clicked again", async () => {
    const input = makeControllerInput({
      routeThreadId: THREAD_B,
      sidebarThreadSummaryById: {
        [THREAD_A]: { id: THREAD_A, projectId: PROJECT_ID, sidechatSourceThreadId: null },
        [THREAD_B]: { id: THREAD_B, projectId: PROJECT_ID, sidechatSourceThreadId: THREAD_A },
      },
    });

    await activateThreadFromSidebarIntent(input, THREAD_B);

    expect(input.openSidechatSplit).toHaveBeenCalledWith({
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      sidechatThreadId: THREAD_B,
    });
    expect(input.navigate).toHaveBeenCalledOnce();
  });
});
