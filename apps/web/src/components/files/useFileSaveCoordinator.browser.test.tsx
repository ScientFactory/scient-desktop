import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  readScope: vi.fn(),
  getUnsavedFile: vi.fn(),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => writeFile) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { setMarkdownTaskChecked } from "./filePreviewMode";
import {
  clearWorkspaceFileSessionsForTests,
  useFileSaveCoordinator,
} from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps: Parameters<typeof useFileSaveCoordinator>[0] = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
  revision: "revision-1",
  onSaveFailure: vi.fn(),
  onSaveConfirmed: vi.fn(),
  onSaveResolutionApplied: vi.fn(),
  saveResolution: null,
};
let root: Root | null;
// The editor's change callback from the latest commit, as an editor would hold it.
let latestChange: (contents: string) => void;
let latestSuspension: (suspended: boolean) => void;

function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
  const coordinator = useFileSaveCoordinator(props);
  const onChange = (contents: string) => coordinator.change(contents);
  useEffect(() => {
    latestChange = onChange;
    latestSuspension = coordinator.setSuspended;
  });
  return null;
}

async function render(props = defaultProps) {
  root ??= createRoot(document.createElement("div"));
  await act(async () =>
    root!.render(
      <StrictMode>
        <FileSurface {...props} />
      </StrictMode>,
    ),
  );
}
const mount = render;

async function unmountSurface() {
  await act(async () => root!.unmount());
  root = null;
}

const changeHandler = () => latestChange;

function suspensionHandler(): (suspended: boolean) => void {
  return latestSuspension;
}

beforeEach(() => {
  clearWorkspaceFileSessionsForTests();
  root = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue(AsyncResult.success({ revision: "revision-2" }));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  onPendingChange.mockReset();
});

afterEach(async () => {
  if (root) await unmountSurface();
  await vi.runAllTimersAsync();
  await Promise.resolve();
  clearWorkspaceFileSessionsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file-save React lifecycle", () => {
  it("uses the confirmed revision for the next edit without recreating the session", async () => {
    await mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(500);
    changeHandler()("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile.mock.calls.map(([request]) => request.input.expectedRevision)).toEqual([
      "revision-1",
      "revision-2",
    ]);
  });

  it("does not adopt a remote revision over pending edits and can discard them explicitly", async () => {
    await mount();
    changeHandler()("local edit");
    const props = { ...defaultProps, revision: "remote-revision" };
    await render({ ...props });
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile.mock.calls[0]![0].input.expectedRevision).toBe("revision-1");
    changeHandler()("another local edit");
    await render({
      ...props,
      saveResolution: {
        id: 1,
        contents: "remote contents",
        relativePath: "file.txt",
        action: "discard",
        revision: "remote-revision",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    await mount();
    changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "AUDIT7907NATIVE\n",
        expectedRevision: "revision-1",
      },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
      "revision-2",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("persists rendered Markdown task changes after StrictMode setup replay", async () => {
    await mount({ ...defaultProps, relativePath: "README.md" });
    const nextContents = setMarkdownTaskChecked("- [ ] task\n", 2, true);
    changeHandler()(nextContents);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "README.md",
        contents: "- [x] task\n",
        expectedRevision: "revision-1",
      },
    });
  });

  it("shares one persistence pipeline between two mounted views of the same file", async () => {
    const changes: Array<(contents: string) => void> = [];
    const firstPending = vi.fn();
    const secondPending = vi.fn();
    function SharedViews() {
      const first = useFileSaveCoordinator({
        ...defaultProps,
        onPendingChange: firstPending,
      });
      const second = useFileSaveCoordinator({
        ...defaultProps,
        onPendingChange: secondPending,
      });
      useEffect(() => {
        changes[0] = first.change;
        changes[1] = second.change;
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(() =>
      root!.render(
        <StrictMode>
          <SharedViews />
        </StrictMode>,
      ),
    );
    changes[0]!("first view");
    changes[1]!("shared latest view");
    await vi.advanceTimersByTimeAsync(500);

    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "shared latest view",
        expectedRevision: "revision-1",
      },
    });
    expect(confirmFile).toHaveBeenCalledOnce();
    expect(firstPending).toHaveBeenLastCalledWith("file.txt", false);
    expect(secondPending).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("keeps the debounce across rerenders of the same file", async () => {
    await mount();
    changeHandler()("first");
    await vi.advanceTimersByTimeAsync(300);
    await render(defaultProps);
    changeHandler()("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("latest");
  });

  it("keeps a suspended shared session held when callback identities change", async () => {
    const latestPendingChange = vi.fn();
    await mount();
    suspensionHandler()(true);
    changeHandler()("held checkpoint");

    await render({
      ...defaultProps,
      onPendingChange: latestPendingChange,
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onSaveResolutionApplied: vi.fn(),
    });
    changeHandler()("latest held checkpoint");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeFile).not.toHaveBeenCalled();

    suspensionHandler()(false);
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "latest held checkpoint",
        expectedRevision: "revision-1",
      },
    });
    expect(latestPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("keeps a shared session serial while callbacks change during a write", async () => {
    let resolveFirst!: (value: ReturnType<typeof AsyncResult.success>) => void;
    const firstWrite = new Promise<ReturnType<typeof AsyncResult.success>>((resolve) => {
      resolveFirst = resolve;
    });
    writeFile
      .mockReset()
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValue(AsyncResult.success({ revision: "revision-3" }));
    const retiredConfirmed = vi.fn();
    const latestConfirmed = vi.fn();
    await mount({ ...defaultProps, onSaveConfirmed: retiredConfirmed });

    changeHandler()("first checkpoint");
    await vi.advanceTimersByTimeAsync(500);
    changeHandler()("queued checkpoint");
    await render({
      ...defaultProps,
      onPendingChange: vi.fn(),
      onSaveConfirmed: latestConfirmed,
      onSaveFailure: vi.fn(),
      onSaveResolutionApplied: vi.fn(),
    });
    changeHandler()("latest checkpoint");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeFile).toHaveBeenCalledTimes(1);

    resolveFirst(AsyncResult.success({ revision: "revision-2" }));
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input).toEqual({
      cwd: "/workspace",
      relativePath: "file.txt",
      contents: "latest checkpoint",
      expectedRevision: "revision-2",
    });
    expect(retiredConfirmed).not.toHaveBeenCalled();
    expect(latestConfirmed).toHaveBeenCalledTimes(2);
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    await mount();
    const retiredChange = changeHandler();
    retiredChange("pending edit");
    await unmountSurface();
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      await mount();
      changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await unmountSurface();
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    await render(defaultProps);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "pending draft",
        expectedRevision: "revision-1",
      },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("recovers an existing draft once after StrictMode setup replay", async () => {
    getUnsavedFile.mockReturnValue({ contents: "reopened draft" });
    await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "file.txt",
        contents: "reopened draft",
        expectedRevision: "revision-1",
      },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    await mount();
    const retiredChange = changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    await render(nextProps);
    retiredChange("stale editor contents");
    changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: {
          cwd: "/workspace",
          relativePath: "file.txt",
          contents: "old file edit",
          expectedRevision: "revision-1",
        },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
          expectedRevision: "revision-1",
        },
      },
    ]);
  });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    await mount();
    const retiredChange = changeHandler();
    await unmountSurface();
    await mount();
    retiredChange("stale contents");
    changeHandler()("current contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("current contents");
  });
});
