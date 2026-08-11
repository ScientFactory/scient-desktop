import { describe, expect, it } from "vite-plus/test";

import { buildScientGeneralChatSidebarModel, isScientSidebarThreadVisible } from "./sidebarModel";

interface TestThread {
  readonly id: string;
  readonly projectId: string | null;
}

const thread = (id: string, projectId: string | null): TestThread => ({ id, projectId });

describe("Scient General Chat sidebar model", () => {
  it("keeps General Chat visible independently of project scope", () => {
    expect(
      isScientSidebarThreadVisible({
        archivedAt: null,
        projectId: null,
        projectMatchesScope: false,
      }),
    ).toBe(true);
    expect(
      isScientSidebarThreadVisible({
        archivedAt: null,
        projectId: "project-a",
        projectMatchesScope: false,
      }),
    ).toBe(false);
    expect(
      isScientSidebarThreadVisible({
        archivedAt: "2026-08-11T00:00:00.000Z",
        projectId: null,
        projectMatchesScope: true,
      }),
    ).toBe(false);
  });

  it("splits every shelf while preserving lifecycle and search order", () => {
    const generalPinned = thread("general-pinned", null);
    const projectPinned = thread("project-pinned", "project-a");
    const generalActive = thread("general-active", null);
    const projectActive = thread("project-active", "project-a");
    const generalSnoozed = thread("general-snoozed", null);
    const projectSettled = thread("project-settled", "project-a");

    const model = buildScientGeneralChatSidebarModel({
      shelves: {
        pinned: [generalPinned, projectPinned],
        active: [projectActive, generalActive],
        snoozed: [generalSnoozed],
        settled: [projectSettled],
      },
      activeDraft: null,
      routeThreadKey: "general-active",
      getThreadKey: (item) => item.id,
    });

    expect(model.generalPinnedThreads).toEqual([generalPinned]);
    expect(model.generalActiveThreads).toEqual([generalActive]);
    expect(model.generalSnoozedThreads).toEqual([generalSnoozed]);
    expect(model.pinnedThreads).toEqual([projectPinned]);
    expect(model.activeThreads).toEqual([projectActive]);
    expect(model.settledThreads).toEqual([projectSettled]);
    expect(model.generalChatThreads).toEqual([generalPinned, generalActive, generalSnoozed]);
    expect(model.searchableThreads).toEqual([
      generalPinned,
      generalActive,
      generalSnoozed,
      projectPinned,
      projectActive,
      projectSettled,
    ]);
    expect(model.activeGeneralChatKey).toBe("general-active");
  });

  it("reveals a General Chat draft but not a project draft", () => {
    const input = {
      shelves: { pinned: [], active: [], snoozed: [], settled: [] },
      routeThreadKey: null,
      getThreadKey: (item: TestThread) => item.id,
    } as const;

    expect(
      buildScientGeneralChatSidebarModel({
        ...input,
        activeDraft: { draftId: "general-draft", projectId: null },
      }).activeGeneralChatKey,
    ).toBe("draft:general-draft");
    expect(
      buildScientGeneralChatSidebarModel({
        ...input,
        activeDraft: { draftId: "project-draft", projectId: "project-a" },
      }).activeGeneralChatKey,
    ).toBeNull();
  });
});
