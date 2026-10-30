import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../../composerDraftStore";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
} from "../../components/threadActionMenu.logic";
import {
  handleOpenInNewWindowMenuAction,
  openInNewWindowMenuItem,
  threadWindowRoute,
} from "./openInNewWindow";

const threadRef = scopeThreadRef(EnvironmentId.make("env 1"), ThreadId.make("thread#1"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("open in new window", () => {
  it("is offered only where the desktop app can open windows", () => {
    vi.stubGlobal("window", { desktopBridge: undefined });
    expect(openInNewWindowMenuItem()).toBeNull();
    vi.stubGlobal("window", { desktopBridge: { openNewWindow: vi.fn() } });
    expect(openInNewWindowMenuItem()?.id).toBe("open-in-new-window");
  });

  it("opens the thread's route in a new window and ignores other actions", () => {
    const openNewWindow = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { desktopBridge: { openNewWindow } });

    expect(handleOpenInNewWindowMenuAction("rename", threadRef)).toBe(false);
    expect(openNewWindow).not.toHaveBeenCalled();
    expect(handleOpenInNewWindowMenuAction("open-in-new-window", threadRef)).toBe(true);
    expect(openNewWindow).toHaveBeenCalledWith("/env%201/thread%231");
    expect(threadWindowRoute(threadRef)).toBe("/env%201/thread%231");
  });

  it("opens a draft's route from the draft menu", () => {
    const openNewWindow = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { desktopBridge: { openNewWindow } });
    const [first] = buildDraftActionMenuItems({
      hasPath: false,
      hasBranch: false,
      hasProject: false,
      openInNewWindow: openInNewWindowMenuItem(),
    });

    expect(handleOpenInNewWindowMenuAction(first?.id ?? null, "draft 1" as DraftId)).toBe(true);
    expect(openNewWindow).toHaveBeenCalledWith("/draft/draft%201");
  });

  it("stays available to read-only connections", () => {
    vi.stubGlobal("window", { desktopBridge: { openNewWindow: vi.fn() } });
    const items = buildThreadActionMenuItems({
      canOperate: false,
      branch: null,
      projectFilter: null,
      isPinned: false,
      isSettled: false,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: true,
        autoSettleOptOut: true,
        snooze: true,
        pinning: true,
        titleRegeneration: true,
      },
      snoozePresets: [],
      openInNewWindow: openInNewWindowMenuItem(),
    });
    expect(items[0]).toMatchObject({ id: "open-in-new-window" });
    expect(items[0]?.disabled).toBeUndefined();
  });
});
