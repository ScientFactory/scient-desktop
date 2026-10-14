import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { act, type ReactNode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionEnvironmentPicker } from "./NewSectionPopover";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moveThreadsToSection: vi.fn(),
  catalogs: [] as Array<{ environmentId: string }>,
  popoverProps: null as null | {
    readonly open: boolean;
    readonly threadCount: number;
    readonly environmentPicker: SectionEnvironmentPicker | null;
    readonly onSubmit: (name: string) => Promise<boolean>;
    readonly onOpenChange: (open: boolean) => void;
  },
}));
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({ catalogs: mocks.catalogs, create: mocks.create }),
}));
vi.mock("./actions", () => ({
  useThreadSectionActions: () => ({ moveThreadsToSection: mocks.moveThreadsToSection }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => ({ projectId: "project-b" }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "Laptop" },
      { environmentId: "remote", label: "Lab server" },
    ],
  }),
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("./NewSectionPopover", () => ({
  NewSectionPopover: (props: NonNullable<typeof mocks.popoverProps>) => {
    mocks.popoverProps = props;
    return null;
  },
}));

import { toastManager } from "../../components/ui/toast";
import { setSidebarSectionScope } from "./sidebarScope";
import { createSectionAndFile, useNewSectionForThreads } from "./useNewSectionForThreads";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const threadRef = { environmentId: LOCAL, threadId: ThreadId.make("thread-1") };
const second = { environmentId: REMOTE, threadId: ThreadId.make("thread-2") };
const design = { id: ThreadSectionId.make("design"), name: "Design", order: 0 };

let hook: ReturnType<typeof useNewSectionForThreads>;
let renderer: ReactTestRenderer;
const onCreated = vi.fn();
function Probe(): ReactNode {
  const value = useNewSectionForThreads({ onCreated });
  useLayoutEffect(() => {
    hook = value;
  });
  return value.popover;
}

function mount() {
  act(() => {
    renderer = create(<Probe />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.catalogs = [{ environmentId: "local" }, { environmentId: "remote" }];
  mocks.popoverProps = null;
  mount();
});
afterEach(() => {
  act(() => renderer.unmount());
  setSidebarSectionScope(null);
  vi.unstubAllGlobals();
});

async function submit(name: string) {
  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.popoverProps!.onSubmit(name);
  });
  return submitted;
}

it("creates the section on the thread's environment and files it there", async () => {
  setSidebarSectionScope([
    { environmentId: "local", projectId: "project-a" },
    { environmentId: "remote", projectId: "project-r" },
  ]);
  mocks.create.mockResolvedValue(design);
  mocks.moveThreadsToSection.mockResolvedValue(true);
  act(() => hook.request([threadRef], { x: 20, y: 100 }));
  // Threads decide the environment, so there is nothing to choose.
  expect(mocks.popoverProps).toMatchObject({ open: true, threadCount: 1, environmentPicker: null });

  expect(await submit("Design")).toBe(true);
  // Recorded for the selected project on this environment and the thread's own.
  expect(mocks.create).toHaveBeenCalledWith(LOCAL, "Design", {
    environmentIds: ["local"],
    createdInProjects: [
      { environmentId: "local", projectId: "project-a" },
      { environmentId: "local", projectId: "project-b" },
    ],
  });
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([threadRef], {
    environmentId: LOCAL,
    sectionId: "design",
  });
  expect(onCreated).toHaveBeenCalledWith({ environmentId: LOCAL, sectionId: "design" });
});

it("gives threads from two environments a section on each of theirs", async () => {
  mocks.create.mockImplementation(async (environmentId: string) => ({
    ...design,
    id: ThreadSectionId.make(`design-${environmentId}`),
  }));
  mocks.moveThreadsToSection.mockResolvedValue(true);
  act(() => hook.request([threadRef, second], { x: 20, y: 100 }));
  expect(mocks.popoverProps).toMatchObject({ threadCount: 2 });
  expect(await submit("Design")).toBe(true);
  expect(mocks.create.mock.calls.map((call) => call[0]).toSorted()).toEqual(["local", "remote"]);
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([threadRef], {
    environmentId: LOCAL,
    sectionId: "design-local",
  });
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([second], {
    environmentId: REMOTE,
    sectionId: "design-remote",
  });
});

it("reports the environments where the section could not be created", async () => {
  mocks.create.mockImplementation(async (environmentId: string) =>
    environmentId === "remote" ? null : design,
  );
  mocks.moveThreadsToSection.mockResolvedValue(true);
  act(() => hook.request([threadRef, second], { x: 20, y: 100 }));
  expect(await submit("Design")).toBe(true);
  expect(mocks.moveThreadsToSection).toHaveBeenCalledTimes(1);
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Section not created everywhere",
      description: expect.stringContaining("Lab server"),
    }),
  );
});

it("files nothing and reports failure when the section cannot be created", async () => {
  mocks.create.mockResolvedValue(null);
  act(() => hook.request([threadRef], { x: 20, y: 100 }));
  expect(await submit("Design")).toBe(false);
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

it("asks which machine holds a section started empty, defaulting to the selected project's", async () => {
  setSidebarSectionScope([{ environmentId: "remote", projectId: "project-r" }]);
  mocks.create.mockResolvedValue(design);
  act(() => hook.request([], { x: 20, y: 100 }));
  const picker = mocks.popoverProps!.environmentPicker!;
  expect(picker.choices).toEqual([
    { environmentId: "local", label: "Laptop" },
    { environmentId: "remote", label: "Lab server" },
  ]);
  expect(picker.value).toBe("remote");
  act(() => picker.onChange(LOCAL));
  expect(mocks.popoverProps!.environmentPicker!.value).toBe("local");
  await submit("Later");
  expect(mocks.create).toHaveBeenCalledWith(LOCAL, "Later", expect.anything());
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

it("creates an empty section on the only environment that stores sections without asking", async () => {
  act(() => renderer.unmount());
  mocks.catalogs = [{ environmentId: "remote" }];
  mount();
  mocks.create.mockResolvedValue(design);
  act(() => hook.request([], { x: 20, y: 100 }));
  expect(mocks.popoverProps!.environmentPicker).toBeNull();
  await submit("Later");
  expect(mocks.create).toHaveBeenCalledWith(REMOTE, "Later", expect.anything());
});

it("does not let an old form close a newer creation request", () => {
  act(() => hook.request([threadRef], { x: 20, y: 100 }));
  const oldForm = mocks.popoverProps!;
  act(() => hook.request([threadRef, second], { x: 80, y: 200 }));
  act(() => oldForm.onOpenChange(false));
  expect(mocks.popoverProps).toMatchObject({
    open: true,
    threadCount: 2,
    anchor: { x: 80, y: 200 },
  });
  act(() => mocks.popoverProps!.onOpenChange(false));
  expect(mocks.popoverProps).toMatchObject({ open: false, anchor: { x: 80, y: 200 } });
});

// The shared create-and-file step.
describe("createSectionAndFile", () => {
  it.each([
    ["one thread", [threadRef]],
    [
      "several threads on one environment",
      [threadRef, { ...threadRef, threadId: ThreadId.make("t-3") }],
    ],
  ])("creates the section, then files %s into it", async (_label, refs) => {
    const steps: string[] = [];
    const result = await createSectionAndFile({
      name: "Design",
      threadRefs: refs,
      scopeProjectRefs: null,
      environmentId: null,
      create: async (environmentId, name, origin) => {
        steps.push(`create ${name} on ${environmentId} ${origin.environmentIds?.join(",")}`);
        return design;
      },
      moveThreadsToSection: async (moved, section) => {
        steps.push(
          `file ${moved.map((ref) => ref.threadId).join(",")} into ${section.sectionId}@${section.environmentId}`,
        );
        return true;
      },
    });
    expect(result.created).toEqual([{ environmentId: LOCAL, section: design }]);
    expect(steps).toEqual([
      "create Design on local local",
      `file ${refs.map((ref) => ref.threadId).join(",")} into design@local`,
    ]);
  });

  it("creates nothing when a section without threads has nowhere to go", async () => {
    const createSection = vi.fn();
    const result = await createSectionAndFile({
      name: "Design",
      threadRefs: [],
      scopeProjectRefs: null,
      environmentId: null,
      create: createSection,
      moveThreadsToSection: vi.fn(),
    });
    expect(result).toEqual({ created: [], failedEnvironmentIds: [] });
    expect(createSection).not.toHaveBeenCalled();
  });

  it("files nothing when the section cannot be created", async () => {
    const move = vi.fn();
    const result = await createSectionAndFile({
      name: "Design",
      threadRefs: [threadRef],
      scopeProjectRefs: null,
      environmentId: null,
      create: async () => null,
      moveThreadsToSection: move,
    });
    expect(result).toEqual({ created: [], failedEnvironmentIds: [LOCAL] });
    expect(move).not.toHaveBeenCalled();
  });
});
