import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { act, type ReactNode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moveThreadsToSection: vi.fn(),
  popoverProps: null as null | {
    readonly open: boolean;
    readonly threadCount: number;
    readonly onSubmit: (name: string) => Promise<boolean>;
  },
}));
vi.mock("./catalog", () => ({ useThreadSectionCatalog: () => ({ create: mocks.create }) }));
vi.mock("./actions", () => ({
  useThreadSectionActions: () => ({ moveThreadsToSection: mocks.moveThreadsToSection }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => ({ projectId: "project-b" }),
}));
vi.mock("./NewSectionPopover", () => ({
  NewSectionPopover: (props: NonNullable<typeof mocks.popoverProps>) => {
    mocks.popoverProps = props;
    return null;
  },
}));

import { setSidebarSectionScope } from "./sidebarScope";
import { createSectionAndFile, useNewSectionForThreads } from "./useNewSectionForThreads";

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};
let hook: ReturnType<typeof useNewSectionForThreads>;
let renderer: ReactTestRenderer;
function Probe(): ReactNode {
  const value = useNewSectionForThreads();
  useLayoutEffect(() => {
    hook = value;
  });
  return value.popover;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReset();
  mocks.moveThreadsToSection.mockReset();
  mocks.popoverProps = null;
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  setSidebarSectionScope(null);
  vi.unstubAllGlobals();
});

it("creates the section for the requested thread and files it there", async () => {
  setSidebarSectionScope([{ environmentId: "local", projectId: "project-a" }]);
  mocks.create.mockResolvedValue({ id: ThreadSectionId.make("design"), name: "Design", order: 0 });
  mocks.moveThreadsToSection.mockResolvedValue(true);
  act(() => hook.request([threadRef], { x: 20, y: 100 }));
  expect(mocks.popoverProps).toMatchObject({ open: true, threadCount: 1 });

  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.popoverProps!.onSubmit("Design");
  });
  expect(submitted).toBe(true);
  // Recorded for the sidebar's selected project and the thread's own.
  expect(mocks.create).toHaveBeenCalledWith("Design", {
    environmentIds: ["local"],
    createdInProjects: [
      { environmentId: "local", projectId: "project-a" },
      { environmentId: "local", projectId: "project-b" },
    ],
  });
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([threadRef], "design");
});

it("files every selected thread", async () => {
  const second = {
    environmentId: EnvironmentId.make("remote"),
    threadId: ThreadId.make("thread-2"),
  };
  mocks.create.mockResolvedValue({ id: ThreadSectionId.make("design"), name: "Design", order: 0 });
  mocks.moveThreadsToSection.mockResolvedValue(true);
  act(() => hook.request([threadRef, second], { x: 20, y: 100 }));
  expect(mocks.popoverProps).toMatchObject({ threadCount: 2 });
  await act(async () => {
    await mocks.popoverProps!.onSubmit("Design");
  });
  expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({ environmentIds: ["local", "remote"] });
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([threadRef, second], "design");
});

it("files nothing and reports failure when the section cannot be created", async () => {
  mocks.create.mockResolvedValue(null);
  act(() => hook.request([threadRef], { x: 20, y: 100 }));
  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.popoverProps!.onSubmit("Design");
  });
  expect(submitted).toBe(false);
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

// The shared create-and-file step.
describe("createSectionAndFile", () => {
  const second = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("t-2") };
  const design = { id: ThreadSectionId.make("design"), name: "Design", order: 0 };

  it.each([
    ["one thread", [threadRef]],
    ["several threads", [threadRef, second]],
  ])("creates the section, then files %s into it", async (_label, refs) => {
    const steps: string[] = [];
    const section = await createSectionAndFile({
      name: "Design",
      threadRefs: refs,
      scopeProjectRefs: null,
      create: async (name, origin) => {
        steps.push(`create ${name} ${origin.environmentIds?.join(",")}`);
        return design;
      },
      moveThreadsToSection: async (moved, sectionId) => {
        steps.push(`file ${moved.map((ref) => ref.threadId).join(",")} into ${sectionId}`);
        return true;
      },
    });
    expect(section).toBe(design);
    expect(steps).toEqual([
      `create Design ${refs.map((ref) => ref.environmentId).join(",")}`,
      `file ${refs.map((ref) => ref.threadId).join(",")} into design`,
    ]);
  });

  it("creates an empty section from the New section row without filing", async () => {
    const move = vi.fn();
    await createSectionAndFile({
      name: "Design",
      threadRefs: [],
      scopeProjectRefs: [{ environmentId: "local", projectId: "project-a" }],
      create: async () => design,
      moveThreadsToSection: move,
    });
    expect(move).not.toHaveBeenCalled();
  });

  it("files nothing when the section cannot be created", async () => {
    const move = vi.fn();
    expect(
      await createSectionAndFile({
        name: "Design",
        threadRefs: [threadRef],
        scopeProjectRefs: null,
        create: async () => null,
        moveThreadsToSection: move,
      }),
    ).toBeNull();
    expect(move).not.toHaveBeenCalled();
  });
});
