import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { type ReactNode, useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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

const onCreated = vi.fn();
function Probe({ _fixture }: { _fixture: _Fixture }): ReactNode {
  const value = useNewSectionForThreads({ onCreated });
  useLayoutEffect(() => {
    _fixture.publishHook(value);
  });
  return value.popover;
}

async function mount(_fixture: _Fixture) {
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  mocks.catalogs = [{ environmentId: "local" }, { environmentId: "remote" }];
  mocks.popoverProps = null;
  await mount(_fixture);
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  setSidebarSectionScope(null);
  vi.unstubAllGlobals();
}

async function submit(name: string) {
  let submitted: boolean | undefined;
  await act(async () => {
    submitted = await mocks.popoverProps!.onSubmit(name);
  });
  return submitted;
}

it("creates the section on the thread's environment and files it there", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  setSidebarSectionScope([
    { environmentId: "local", projectId: "project-a" },
    { environmentId: "remote", projectId: "project-r" },
  ]);
  mocks.create.mockResolvedValue(design);
  mocks.moveThreadsToSection.mockResolvedValue(true);
  await act(() => _fixture.hook.request([threadRef], { x: 20, y: 100 }));
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.create.mockImplementation(async (environmentId: string) => ({
    ...design,
    id: ThreadSectionId.make(`design-${environmentId}`),
  }));
  mocks.moveThreadsToSection.mockResolvedValue(true);
  await act(() => _fixture.hook.request([threadRef, second], { x: 20, y: 100 }));
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.create.mockImplementation(async (environmentId: string) =>
    environmentId === "remote" ? null : design,
  );
  mocks.moveThreadsToSection.mockResolvedValue(true);
  await act(() => _fixture.hook.request([threadRef, second], { x: 20, y: 100 }));
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.create.mockResolvedValue(null);
  await act(() => _fixture.hook.request([threadRef], { x: 20, y: 100 }));
  expect(await submit("Design")).toBe(false);
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

it("asks which machine holds a section started empty, defaulting to the selected project's", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  setSidebarSectionScope([{ environmentId: "remote", projectId: "project-r" }]);
  mocks.create.mockResolvedValue(design);
  await act(() => _fixture.hook.request([], { x: 20, y: 100 }));
  const picker = mocks.popoverProps!.environmentPicker!;
  expect(picker.choices).toEqual([
    { environmentId: "local", label: "Laptop" },
    { environmentId: "remote", label: "Lab server" },
  ]);
  expect(picker.value).toBe("remote");
  await act(() => picker.onChange(LOCAL));
  expect(mocks.popoverProps!.environmentPicker!.value).toBe("local");
  await submit("Later");
  expect(mocks.create).toHaveBeenCalledWith(LOCAL, "Later", expect.anything());
  expect(mocks.moveThreadsToSection).not.toHaveBeenCalled();
});

it("creates an empty section on the only environment that stores sections without asking", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(async () => await _fixture.root0.unmount());
  mocks.catalogs = [{ environmentId: "remote" }];
  await mount(_fixture);
  mocks.create.mockResolvedValue(design);
  await act(() => _fixture.hook.request([], { x: 20, y: 100 }));
  expect(mocks.popoverProps!.environmentPicker).toBeNull();
  await submit("Later");
  expect(mocks.create).toHaveBeenCalledWith(REMOTE, "Later", expect.anything());
});

it("does not let an old form close a newer creation request", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => _fixture.hook.request([threadRef], { x: 20, y: 100 }));
  const oldForm = mocks.popoverProps!;
  await act(() => _fixture.hook.request([threadRef, second], { x: 80, y: 200 }));
  await act(() => oldForm.onOpenChange(false));
  expect(mocks.popoverProps).toMatchObject({
    open: true,
    threadCount: 2,
    anchor: { x: 80, y: 200 },
  });
  await act(() => mocks.popoverProps!.onOpenChange(false));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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

function _createFixture() {
  let _published_hook = undefined! as ReturnType<typeof useNewSectionForThreads>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get hook() {
      return _published_hook;
    },
    publishHook(next: typeof _published_hook) {
      _published_hook = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen,
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
