import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { act, type ReactNode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moveThreadsToSection: vi.fn(),
  dialogProps: null as null | {
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
vi.mock("./NewSectionDialog", () => ({
  NewSectionDialog: (props: NonNullable<typeof mocks.dialogProps>) => {
    mocks.dialogProps = props;
    return null;
  },
}));

import { setSidebarSectionScope } from "./sidebarScope";
import { useNewSectionForThreads } from "./useNewSectionForThreads";

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
  return value.dialog;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.create.mockReset();
  mocks.moveThreadsToSection.mockReset();
  mocks.dialogProps = null;
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
  act(() => hook.request([threadRef]));
  expect(mocks.dialogProps).toMatchObject({ open: true, threadCount: 1 });

  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.dialogProps!.onSubmit("Design");
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
  act(() => hook.request([threadRef, second]));
  expect(mocks.dialogProps).toMatchObject({ threadCount: 2 });
  await act(async () => {
    await mocks.dialogProps!.onSubmit("Design");
  });
  expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({ environmentIds: ["local", "remote"] });
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith([threadRef, second], "design");
});

it("files nothing and reports failure when the section cannot be created", async () => {
  mocks.create.mockResolvedValue(null);
  act(() => hook.request([threadRef]));
  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.dialogProps!.onSubmit("Design");
  });
  expect(submitted).toBe(false);
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});
