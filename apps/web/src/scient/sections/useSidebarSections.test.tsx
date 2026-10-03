import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { act, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moveThreadsToSection: vi.fn(),
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
  useThreadSectionCatalog: () => ({
    available: true,
    sections: [],
    generalIndex: 0,
    create: mocks.create,
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
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => "local",
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
    useState(key === "scient:sidebar:view-mode" ? mocks.mode : initial),
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => null }));

import { useSidebarSections } from "./useSidebarSections";

let sections: ReturnType<typeof useSidebarSections>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useSidebarSections({
    threads: [],
    scopeProjectRefs: [{ environmentId: "local", projectId: "project-a" }],
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReset();
  mocks.moveThreadsToSection.mockReset();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

const refs = [
  { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("t1") },
  { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("t2") },
];

it.each(["sections", "status"])(
  "creates and files threads in an anchored popover in %s mode",
  async (mode) => {
    mocks.mode = mode;
    act(() => {
      renderer.unmount();
      renderer = create(<Probe />);
    });
    mocks.create.mockResolvedValue({
      id: ThreadSectionId.make("design"),
      name: "Design",
      order: 0,
    });
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
    expect(mocks.create).toHaveBeenCalledWith("Design", {
      environmentIds: ["local", "local"],
      createdInProjects: [
        { environmentId: "local", projectId: "project-a" },
        { environmentId: "local", projectId: "project-a" },
        { environmentId: "local", projectId: "project-a" },
      ],
    });
    expect(mocks.moveThreadsToSection).toHaveBeenCalledWith(refs, "design");
    expect(mocks.popoverProps).toMatchObject({ open: false });
  },
);

it("creates an empty section from the New section row", async () => {
  mocks.create.mockResolvedValue({ id: ThreadSectionId.make("design"), name: "Design", order: 0 });
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
    "Design",
    expect.objectContaining({
      createdInProjects: [{ environmentId: "local", projectId: "project-a" }],
    }),
  );
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});
