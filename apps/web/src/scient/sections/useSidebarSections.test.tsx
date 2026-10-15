import { EnvironmentId, ThreadId, ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { act, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reorder: vi.fn(),
  moveThreadsToSection: vi.fn(),
  catalogs: [] as Array<{ environmentId: string; sections: ThreadSection[]; generalIndex: number }>,
  collapsed: [] as string[],
  scope: null as null | Array<{ environmentId: string; projectId: string }>,
  popoverProps: null as null | {
    readonly open: boolean;
    readonly threadCount: number;
    readonly anchor: unknown;
    readonly onSubmit: (name: string) => Promise<boolean>;
    readonly onOpenChange: (open: boolean) => void;
  },
  mode: "sections",
}));
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({
    available: mocks.catalogs.length > 0,
    catalogs: mocks.catalogs,
    catalogFor: (environmentId: string) =>
      mocks.catalogs.find((catalog) => catalog.environmentId === environmentId) ?? null,
    create: mocks.create,
    reorder: mocks.reorder,
  }),
}));
vi.mock("./actions", () => ({
  readEnvironmentSupportsSections: () => true,
  useThreadSectionActions: () => ({
    moveThreadsToSection: mocks.moveThreadsToSection,
    setThreadSection: vi.fn(),
  }),
}));
vi.mock("./useEmptySectionCleanup", () => ({ useEmptySectionCleanup: () => {} }));
vi.mock("./pendingNewThreadSections", () => ({
  rememberSectionForNewThread: vi.fn(),
  useApplyPendingNewThreadSections: () => {},
}));
vi.mock("./loadedEnvironments", () => ({ loadedThreadEnvironmentsKeyAtom: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => "" }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "Laptop" },
      { environmentId: "remote", label: "Lab server" },
    ],
  }),
}));
vi.mock("../../state/entities", () => ({ readThreadShell: () => ({ projectId: "project-a" }) }));
vi.mock("./NewSectionPopover", () => ({
  NewSectionPopover: (props: NonNullable<typeof mocks.popoverProps>) => {
    mocks.popoverProps = props;
    return null;
  },
}));
// The same creation surface is used in both modes.
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, initial: unknown) =>
    useState(
      key === "scient:sidebar:view-mode"
        ? mocks.mode
        : key === "scient:sidebar:collapsed-sections"
          ? mocks.collapsed
          : initial,
    ),
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));

import { GENERAL_SECTION_GROUP_ID, sectionGroupId } from "./logic";
import { projectRefForSection, useSidebarSections } from "./useSidebarSections";

const LOCAL = EnvironmentId.make("local");
const section = (id: string, order: number): ThreadSection => ({
  id: ThreadSectionId.make(id),
  name: id.toUpperCase(),
  order,
});

let sections: ReturnType<typeof useSidebarSections>;
let renderer: ReactTestRenderer | undefined;
function Probe() {
  const value = useSidebarSections({
    threads: [],
    scopeProjectRefs: mocks.scope,
    pinnedThreads: [],
    activeThreads: [],
    routeThreadKey: null,
    newThreadContext: {} as never,
    onBeforeNewThread: () => {},
  });
  useLayoutEffect(() => {
    sections = value;
  });
  return value.popover;
}
function mount() {
  act(() => {
    renderer?.unmount();
    renderer = create(<Probe />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.mode = "sections";
  mocks.collapsed = [];
  mocks.scope = [{ environmentId: "local", projectId: "project-a" }];
  mocks.catalogs = [{ environmentId: "local", sections: [], generalIndex: 0 }];
  mocks.reorder.mockResolvedValue(true);
  mount();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const refs = [
  { environmentId: LOCAL, threadId: ThreadId.make("t1") },
  { environmentId: LOCAL, threadId: ThreadId.make("t2") },
];

it.each(["sections", "status"])(
  "creates and files threads in an anchored popover in %s mode",
  async (mode) => {
    mocks.mode = mode;
    mount();
    mocks.create.mockResolvedValue(section("design", 0));
    mocks.moveThreadsToSection.mockResolvedValue(true);
    expect(sections.sectionsView).toBe(mode === "sections");
    await act(async () => {
      await sections.handleSectionMenuAction("section:new", refs, { x: 20, y: 100 });
    });
    expect(mocks.popoverProps).toMatchObject({
      open: true,
      threadCount: 2,
      anchor: { x: 20, y: 100 },
    });
    await act(async () => {
      await mocks.popoverProps!.onSubmit("Design");
      mocks.popoverProps!.onOpenChange(false);
    });
    expect(mocks.create).toHaveBeenCalledWith(LOCAL, "Design", {
      environmentIds: ["local"],
      createdInProjects: [
        { environmentId: "local", projectId: "project-a" },
        { environmentId: "local", projectId: "project-a" },
        { environmentId: "local", projectId: "project-a" },
      ],
    });
    expect(mocks.moveThreadsToSection).toHaveBeenCalledWith(refs, {
      environmentId: LOCAL,
      sectionId: "design",
    });
    expect(mocks.popoverProps).toMatchObject({ open: false });
  },
);

it("creates an empty section from the New section row", async () => {
  mocks.create.mockResolvedValue(section("design", 0));
  act(() => sections.viewProps.onStartCreateSection({ x: 20, y: 100 }));
  expect(mocks.popoverProps).toMatchObject({
    open: true,
    threadCount: 0,
    anchor: { x: 20, y: 100 },
  });
  await act(async () => {
    await mocks.popoverProps!.onSubmit("Design");
    mocks.popoverProps!.onOpenChange(false);
  });
  expect(mocks.create).toHaveBeenCalledWith(
    LOCAL,
    "Design",
    expect.objectContaining({
      createdInProjects: [{ environmentId: "local", projectId: "project-a" }],
    }),
  );
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

describe("starting a thread in a section", () => {
  const lab = { environmentId: "lab", section: section("runs", 0) };
  const shell = (environmentId: string, projectId: string, extra: object = {}) =>
    ({
      environmentId,
      projectId,
      sectionId: "runs",
      archivedAt: null,
      ...extra,
    }) as never;
  const laptopContext = { environmentId: LOCAL, projectId: "laptop-project" } as never;

  it("keeps the current project when it is on the section's machine", () => {
    const context = { environmentId: "lab", projectId: "current" } as never;
    expect(projectRefForSection(lab, context, [])).toBe(context);
  });

  it("uses a member thread's project on the section's machine, even a settled one", () => {
    expect(
      projectRefForSection(lab, laptopContext, [
        // Same section id, other machine: not a member.
        shell("local", "laptop-only"),
        shell("lab", "archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
        shell("lab", "settled", { settledOverride: "settled" }),
      ]),
    ).toEqual({ environmentId: "lab", projectId: "settled" });
  });

  it("falls back to a project the section was created for, else none", () => {
    const created = {
      ...lab,
      section: { ...lab.section, createdInProjects: [{ environmentId: "lab", projectId: "made" }] },
    };
    expect(projectRefForSection(created, laptopContext, [])).toEqual({
      environmentId: "lab",
      projectId: "made",
    });
    expect(projectRefForSection(lab, laptopContext, [])).toBeNull();
  });
});

describe("environment-local catalogs", () => {
  // All projects, so every section lists.
  beforeEach(() => {
    mocks.scope = null;
  });

  it("offers grouping whenever some environment stores sections, primary or not", () => {
    mocks.catalogs = [];
    mount();
    expect(sections.toggle).toBeNull();
    expect(sections.sectionsView).toBe(false);
    mocks.catalogs = [{ environmentId: "remote", sections: [], generalIndex: 0 }];
    mount();
    expect(sections.toggle).not.toBeNull();
    expect(sections.sectionsView).toBe(true);
  });

  it("writes only the environments whose own order changed", () => {
    mocks.catalogs = [
      { environmentId: "local", sections: [section("a", 0), section("b", 1)], generalIndex: 2 },
      { environmentId: "remote", sections: [section("c", 0)], generalIndex: 1 },
    ];
    mount();
    const a = sectionGroupId({ environmentId: "local", sectionId: "a" });
    const b = sectionGroupId({ environmentId: "local", sectionId: "b" });
    const c = sectionGroupId({ environmentId: "remote", sectionId: "c" });
    expect(sections.viewProps.groups.map((group) => group.id)).toEqual([
      a,
      b,
      c,
      GENERAL_SECTION_GROUP_ID,
    ]);
    // Only the order between environments changes, and it is not stored.
    act(() => sections.viewProps.onReorderSections([c, a, b, GENERAL_SECTION_GROUP_ID]));
    expect(mocks.reorder).not.toHaveBeenCalled();
    // General moves between B and A on the laptop, and above C on the server.
    act(() => sections.viewProps.onReorderSections([a, GENERAL_SECTION_GROUP_ID, b, c]));
    expect(mocks.reorder).toHaveBeenCalledTimes(2);
    expect(mocks.reorder).toHaveBeenCalledWith("local", ["a", GENERAL_SECTION_GROUP_ID, "b"]);
    expect(mocks.reorder).toHaveBeenCalledWith("remote", [GENERAL_SECTION_GROUP_ID, "c"]);
  });

  it("names machines on section headers only when several environments' sections show", () => {
    mocks.catalogs = [{ environmentId: "local", sections: [section("a", 0)], generalIndex: 1 }];
    mount();
    expect(sections.viewProps.environmentLabels).toBeNull();
    mocks.catalogs = [
      { environmentId: "local", sections: [section("a", 0)], generalIndex: 1 },
      { environmentId: "remote", sections: [section("c", 0)], generalIndex: 1 },
    ];
    mount();
    expect(sections.viewProps.environmentLabels).toEqual(
      new Map([
        ["local", "Laptop"],
        ["remote", "Lab server"],
      ]),
    );
  });

  it("keeps sections collapsed by their pre-environment ids, and expands them by group id", () => {
    mocks.catalogs = [{ environmentId: "local", sections: [section("a", 0)], generalIndex: 1 }];
    mocks.collapsed = ["a"];
    mount();
    const a = sectionGroupId({ environmentId: "local", sectionId: "a" });
    expect(sections.viewProps.collapsedGroupIds.has(a)).toBe(true);
    act(() => sections.viewProps.onToggleGroup(a));
    expect(sections.viewProps.collapsedGroupIds.has(a)).toBe(false);
    act(() => sections.viewProps.onToggleGroup(a));
    expect(sections.viewProps.collapsedGroupIds.has(a)).toBe(true);
  });
});
