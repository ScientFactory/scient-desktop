import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  shell: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.mutate }));
vi.mock("../../state/entities", () => ({ readThreadShell: mocks.shell }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setSection: {} } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        ["remote", { environment: { capabilities: { threadSections: true } } }],
        ["primary", { environment: { capabilities: { threadSections: true } } }],
        ["old", { environment: { capabilities: {} } }],
      ]),
  },
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { ThreadSectionElsewhereError, useThreadSectionActions } from "./actions";

const REMOTE = EnvironmentId.make("remote");
const target = scopeThreadRef(REMOTE, ThreadId.make("thread"));
const sectionId = ThreadSectionId.make("research");
const section = { environmentId: REMOTE, sectionId };
let actions: ReturnType<typeof useThreadSectionActions>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useThreadSectionActions();
  useLayoutEffect(() => {
    actions = value;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.shell.mockReturnValue({ sectionId: null });
  mocks.mutate.mockResolvedValue(AsyncResult.success(undefined));
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("section membership", () => {
  it("files a thread into a section of its own environment, on that environment only", async () => {
    expect((await actions.setThreadSection(target, section))._tag).toBe("Success");
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({
      environmentId: REMOTE,
      input: { threadId: target.threadId, sectionId },
    });
  });

  it("refuses a section of another environment without writing anything", async () => {
    const result = await actions.setThreadSection(target, {
      environmentId: EnvironmentId.make("primary"),
      sectionId,
    });
    expect(result._tag).toBe("Failure");
    expect(
      result._tag === "Failure" && Cause.squash(result.cause as Cause.Cause<unknown>),
    ).toBeInstanceOf(ThreadSectionElsewhereError);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("refuses a thread whose server does not store sections", async () => {
    const old = EnvironmentId.make("old");
    const result = await actions.setThreadSection(scopeThreadRef(old, ThreadId.make("t")), {
      environmentId: old,
      sectionId,
    });
    expect(result._tag).toBe("Failure");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("moves a thread to General", async () => {
    mocks.shell.mockReturnValue({ sectionId });
    expect((await actions.setThreadSection(target, null))._tag).toBe("Success");
    expect(mocks.mutate).toHaveBeenCalledWith({
      environmentId: REMOTE,
      input: { threadId: target.threadId, sectionId: null },
    });
  });

  it("skips a thread already in the section", async () => {
    mocks.shell.mockReturnValue({ sectionId });
    expect((await actions.setThreadSection(target, section))._tag).toBe("Success");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe("moving threads into a section", () => {
  const other = scopeThreadRef(REMOTE, ThreadId.make("other"));

  it("files every thread and offers an Undo that restores its previous section", async () => {
    expect(await actions.moveThreadsToSection([target, other], section)).toBe(true);
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.mutate).toHaveBeenCalledWith({
      environmentId: other.environmentId,
      input: { threadId: other.threadId, sectionId },
    });
    const notices = vi.mocked(showThreadUndoNotice).mock.calls;
    expect(notices).toHaveLength(2);
    expect(notices[0]?.[0]).toMatchObject({ action: "Moved" });
    // Undo writes the thread's previous section (General) back.
    mocks.shell.mockReturnValue({ sectionId });
    await notices[0]![0].undo();
    expect(mocks.mutate).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, sectionId: null },
    });
  });

  it("restores a previous section on the thread's own environment", async () => {
    const previous = ThreadSectionId.make("previous");
    mocks.shell.mockReturnValue({ sectionId: previous });
    await actions.moveThreadsToSection([target], section);
    mocks.shell.mockReturnValue({ sectionId });
    await vi.mocked(showThreadUndoNotice).mock.calls[0]![0].undo();
    expect(mocks.mutate).toHaveBeenLastCalledWith({
      environmentId: REMOTE,
      input: { threadId: target.threadId, sectionId: previous },
    });
  });

  it("returns false for interrupted membership without an error toast or Undo", async () => {
    mocks.mutate.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    expect(await actions.moveThreadsToSection([target], section)).toBe(false);
    expect(showThreadUndoNotice).not.toHaveBeenCalled();
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("reports a refused move instead of silently leaving the section empty", async () => {
    vi.mocked(stackedThreadToast).mockImplementation((toast) => toast as never);
    const elsewhere = { environmentId: EnvironmentId.make("primary"), sectionId };
    expect(await actions.moveThreadsToSection([target], elsewhere)).toBe(false);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(showThreadUndoNotice).not.toHaveBeenCalled();
    expect(vi.mocked(toastManager.add)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to move thread to section",
        description: new ThreadSectionElsewhereError({
          environmentId: REMOTE,
          threadId: target.threadId,
        }).message,
      }),
    );
  });
});
