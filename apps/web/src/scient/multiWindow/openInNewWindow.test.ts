import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftId } from "../../composerDraftStore";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
} from "../../components/threadActionMenu.logic";
import { handleOpenInNewWindowMenuAction, openInNewWindowMenuItem } from "./openInNewWindow";

function setup() {
  const openNewWindow = vi.fn(() => Promise.resolve(true));
  vi.stubGlobal("window", { desktopBridge: { openNewWindow } });
  return { openNewWindow, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const readOnlyThreadMenu = () =>
  buildThreadActionMenuItems({
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

const draftMenu = () =>
  buildDraftActionMenuItems({
    hasPath: false,
    hasBranch: false,
    hasProject: false,
    openInNewWindow: openInNewWindowMenuItem(),
  });

describe("open in new window", () => {
  it.each([
    {
      name: "a thread, from a read-only connection",
      menu: readOnlyThreadMenu,
      target: scopeThreadRef(EnvironmentId.make("env 1"), ThreadId.make("thread#1")),
      route: "/env%201/thread%231",
    },
    {
      name: "a draft",
      menu: draftMenu,
      target: "draft 1" as DraftId,
      route: "/draft/draft%201",
    },
  ])("opens $name on its route", ({ menu, target, route }) => {
    using desktop = setup();
    const item = menu().find((entry) => entry.id === "open-in-new-window");
    expect(item).toBeDefined();
    expect(item?.disabled).toBeUndefined();

    expect(handleOpenInNewWindowMenuAction("rename", target)).toBe(false);
    expect(desktop.openNewWindow).not.toHaveBeenCalled();
    expect(handleOpenInNewWindowMenuAction(item!.id, target)).toBe(true);
    expect(desktop.openNewWindow).toHaveBeenCalledExactlyOnceWith(route);
  });
});
