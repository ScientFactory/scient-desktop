import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { act, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moveThreadsToSection: vi.fn(),
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
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/entities", () => ({ readThreadShell: () => ({ projectId: "project-a" }) }));
// Grouped by section, so New section… opens the inline row.
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string, initial: unknown) =>
    useState(key === "scient:sidebar:view-mode" ? "sections" : initial),
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
  return null;
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

it("files the threads New section… was chosen for when the inline row is submitted", async () => {
  mocks.create.mockResolvedValue({ id: ThreadSectionId.make("design"), name: "Design", order: 0 });
  mocks.moveThreadsToSection.mockResolvedValue(true);
  expect(sections.sectionsView).toBe(true);
  await act(async () => {
    await sections.handleSectionMenuAction("section:new", refs);
  });
  expect(sections.viewProps.creatingSection).toMatchObject({ threadCount: 2 });
  await act(async () => {
    await sections.viewProps.creatingSection!.onSubmit("Design");
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
  expect(sections.viewProps.creatingSection).toBeNull();
});

it("creates an empty section from the New section row", async () => {
  mocks.create.mockResolvedValue({ id: ThreadSectionId.make("design"), name: "Design", order: 0 });
  act(() => sections.viewProps.onStartCreateSection());
  expect(sections.viewProps.creatingSection).toMatchObject({ threadCount: 0 });
  await act(async () => {
    await sections.viewProps.creatingSection!.onSubmit("Design");
  });
  expect(mocks.create).toHaveBeenCalledWith(
    "Design",
    expect.objectContaining({
      createdInProjects: [{ environmentId: "local", projectId: "project-a" }],
    }),
  );
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});
