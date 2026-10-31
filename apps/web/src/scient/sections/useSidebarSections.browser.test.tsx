import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, ThreadId, ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { useLayoutEffect, useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  configsAtom: { atom: "configs" },
  frozenAtom: { atom: "frozen" },
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
vi.mock("./loadedEnvironments", () => ({
  loadedThreadEnvironmentsKeyAtom: {},
  frozenPlacementEnvironmentsKeyAtom: mocks.frozenAtom,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: mocks.configsAtom }));
// Placement stays unready here (an incomplete catalog); its own hook tests cover it.
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (atom: unknown) =>
    atom === mocks.configsAtom ? new Map() : atom === mocks.frozenAtom ? null : "",
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "Laptop" },
      { environmentId: "remote", label: "Lab server" },
    ],
  }),
  useEnvironmentMachines: () => new Map([["local", "laptop"]]),
}));
vi.mock("../../state/entities", () => {
  const delegatedUnderParent: ReadonlySet<string> = new Set();
  return {
    readThreadShell: () => ({ projectId: "project-a" }),
    useDelegatedUnderParent: () => delegatedUnderParent,
  };
});
vi.mock("./NewSectionPopover", () => ({
  NewSectionPopover: (props: NonNullable<typeof mocks.popoverProps>) => {
    mocks.popoverProps = props;
    return null;
  },
}));
// The same creation surface is used in both modes.
vi.mock("../../hooks/useLocalStorage", async (original) => ({
  ...(await original<typeof import("../../hooks/useLocalStorage")>()),
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

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const value = useSidebarSections({
    threads: [],
    scopeProjectRefs: mocks.scope,
    pinnedThreads: [],
    activeThreads: [],
    routeThreadKey: null,
    now: "2026-10-26T00:00:00.000Z",
    newThreadContext: {} as never,
    onBeforeNewThread: () => {},
  });
  useLayoutEffect(() => {
    _fixture.publishSections(value);
  });
  return value.popover;
}
async function mount(_fixture: _Fixture) {
  await act(async () => {
    await _fixture.root0?.unmount();
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  mocks.mode = "sections";
  mocks.collapsed = [];
  mocks.scope = [{ environmentId: "local", projectId: "project-a" }];
  mocks.catalogs = [{ environmentId: "local", sections: [], generalIndex: 0 }];
  mocks.reorder.mockResolvedValue(true);
  await mount(_fixture);
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const refs = [
  { environmentId: LOCAL, threadId: ThreadId.make("t1") },
  { environmentId: LOCAL, threadId: ThreadId.make("t2") },
];

it.each(["sections", "status"])(
  "creates and files threads in an anchored popover in %s mode",
  async (mode) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.mode = mode;
    await mount(_fixture);
    mocks.create.mockResolvedValue(section("design", 0));
    mocks.moveThreadsToSection.mockResolvedValue(true);
    expect(_fixture.sections.sectionsView).toBe(mode === "sections");
    await act(async () => {
      await _fixture.sections.handleSectionMenuAction("section:new", refs, { x: 20, y: 100 });
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.create.mockResolvedValue(section("design", 0));
  await act(() => _fixture.sections.viewProps.onStartCreateSection({ x: 20, y: 100 }));
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

  it("keeps the current project when it is on the section's machine", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const context = { environmentId: "lab", projectId: "current" } as never;
    expect(projectRefForSection(lab, context, [])).toBe(context);
  });

  it("uses a member thread's project on the section's machine, even a settled one", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(
      projectRefForSection(lab, laptopContext, [
        // Same section id, other machine: not a member.
        shell("local", "laptop-only"),
        shell("lab", "archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
        shell("lab", "settled", { settledOverride: "settled" }),
      ]),
    ).toEqual({ environmentId: "lab", projectId: "settled" });
  });

  it("falls back to a project the section was created for, else none", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
  async function _setupFixture2(_fixture: _Fixture) {
    mocks.scope = null;
  }

  it("offers grouping whenever some environment stores sections, primary or not", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.catalogs = [];
    await mount(_fixture);
    expect(_fixture.sections.toggle).toBeNull();
    expect(_fixture.sections.sectionsView).toBe(false);
    mocks.catalogs = [{ environmentId: "remote", sections: [], generalIndex: 0 }];
    await mount(_fixture);
    expect(_fixture.sections.toggle).not.toBeNull();
    expect(_fixture.sections.sectionsView).toBe(true);
  });

  it("writes only the environments whose own order changed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.catalogs = [
      { environmentId: "local", sections: [section("a", 0), section("b", 1)], generalIndex: 2 },
      { environmentId: "remote", sections: [section("c", 0)], generalIndex: 1 },
    ];
    await mount(_fixture);
    const a = sectionGroupId({ environmentId: "local", sectionId: "a" });
    const b = sectionGroupId({ environmentId: "local", sectionId: "b" });
    const c = sectionGroupId({ environmentId: "remote", sectionId: "c" });
    expect(_fixture.sections.viewProps.groups.map((group) => group.id)).toEqual([
      a,
      b,
      c,
      GENERAL_SECTION_GROUP_ID,
    ]);
    // Only the order between environments changes, and it is not stored.
    await act(() =>
      _fixture.sections.viewProps.onReorderSections([c, a, b, GENERAL_SECTION_GROUP_ID]),
    );
    expect(mocks.reorder).not.toHaveBeenCalled();
    // General moves between B and A on the laptop, and above C on the server.
    await act(() =>
      _fixture.sections.viewProps.onReorderSections([a, GENERAL_SECTION_GROUP_ID, b, c]),
    );
    expect(mocks.reorder).toHaveBeenCalledTimes(2);
    expect(mocks.reorder).toHaveBeenCalledWith("local", ["a", GENERAL_SECTION_GROUP_ID, "b"]);
    expect(mocks.reorder).toHaveBeenCalledWith("remote", [GENERAL_SECTION_GROUP_ID, "c"]);
  });

  it("marks section headers with machines only when several environments' sections show", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.catalogs = [{ environmentId: "local", sections: [section("a", 0)], generalIndex: 1 }];
    await mount(_fixture);
    expect(_fixture.sections.viewProps.environmentMachines).toBeNull();
    mocks.catalogs = [
      { environmentId: "local", sections: [section("a", 0)], generalIndex: 1 },
      { environmentId: "remote", sections: [section("c", 0)], generalIndex: 1 },
    ];
    await mount(_fixture);
    expect(_fixture.sections.viewProps.environmentMachines).toEqual(
      new Map([
        ["local", { label: "Laptop", kind: "laptop" }],
        // A machine that has not reported its kind shows the server icon, as thread rows do.
        ["remote", { label: "Lab server", kind: "server" }],
      ]),
    );
  });

  it("keeps sections collapsed by their pre-environment ids, and expands them by group id", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.catalogs = [{ environmentId: "local", sections: [section("a", 0)], generalIndex: 1 }];
    mocks.collapsed = ["a"];
    await mount(_fixture);
    const a = sectionGroupId({ environmentId: "local", sectionId: "a" });
    expect(_fixture.sections.viewProps.collapsedGroupIds.has(a)).toBe(true);
    await act(() => _fixture.sections.viewProps.onToggleGroup(a));
    expect(_fixture.sections.viewProps.collapsedGroupIds.has(a)).toBe(false);
    await act(() => _fixture.sections.viewProps.onToggleGroup(a));
    expect(_fixture.sections.viewProps.collapsedGroupIds.has(a)).toBe(true);
  });
});

function _createFixture() {
  let _published_sections = undefined! as ReturnType<typeof useSidebarSections>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get sections() {
      return _published_sections;
    },
    publishSections(next: typeof _published_sections) {
      _published_sections = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
