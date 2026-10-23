import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
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
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "export-conversation",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "export-conversation",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          autoSettleOptOut: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
        },
      }),
    ).toEqual([
      "rename",
      "mark-unread",
      "copy",
      "export-conversation",
      "project-settings",
      "archive",
      "delete",
    ]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    // SCIENT-FORK: conversation export sits between Copy and Project settings.
    expect(items[copyIndex + 1]).toMatchObject({ id: "export-conversation", label: "Export" });
    expect(items[copyIndex + 2]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    expect(items[copyIndex + 3]?.id).toBe("archive");
  });

  // SCIENT-FORK:START
  it("places Section in the first group, after pin, settle and snooze", () => {
    const sectionMenu = {
      id: "section" as const,
      label: "Section",
      children: [{ id: "section:new" as const, label: "New section…" }],
    };
    const items = buildThreadActionMenuItems({ ...baseState, sectionMenu });
    expect(items.map((item) => item.id).slice(0, 5)).toEqual([
      "pin",
      "settle",
      "snooze",
      "section",
      "rename",
    ]);
    expect(items[3]?.separatorBefore).toBeFalsy();
    expect(items[4]?.separatorBefore).toBe(true);
  });

  it("leaves no gap in the first group when sections are unavailable", () => {
    expect(ids({ ...baseState, sectionMenu: null }).slice(0, 4)).toEqual([
      "pin",
      "settle",
      "snooze",
      "rename",
    ]);
  });
  // SCIENT-FORK:END

  // SCIENT-FORK:START
  it("offers one Export entry per format and copies the conversation from the Copy submenu", () => {
    const items = buildThreadActionMenuItems(baseState);
    const exportItem = items.find((item) => item.id === "export-conversation");
    expect(
      exportItem?.children?.map((child) => ({
        id: child.id,
        label: child.label,
        disabled: child.disabled,
      })),
    ).toEqual([
      { id: "export-conversation:markdown", label: "Markdown (.md)", disabled: undefined },
      { id: "export-conversation:pdf", label: "PDF (.pdf)", disabled: undefined },
      { id: "export-conversation:docx", label: "Word (.docx)", disabled: undefined },
      { id: "export-conversation:scic", label: "Scient file (.scic)", disabled: undefined },
    ]);
    const copyItem = items.find((item) => item.id === "copy");
    expect(copyItem?.children?.map((child) => child.id)).toEqual([
      "copy-path",
      "copy-thread-id",
      "copy-conversation-markdown",
    ]);
    expect(copyItem?.children?.at(-1)?.label).toBe("Conversation as Markdown");
  });
  // SCIENT-FORK:END

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});
