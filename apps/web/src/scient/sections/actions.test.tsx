import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, ThreadSectionId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  mutate: vi.fn(),
  shell: vi.fn(),
}));
vi.mock("./catalog", () => ({
  useThreadSectionCatalog: () => ({ recordEnvironments: mocks.record }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.mutate }));
vi.mock("../../state/entities", () => ({ readThreadShell: mocks.shell }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setSection: {} } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => new Map([["remote", { environment: { capabilities: { threadSections: true } } }]]),
  },
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { stackedThreadToast } from "../../components/ui/toast";
import { useThreadSectionActions } from "./actions";

const target = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("thread"));
const section = ThreadSectionId.make("research");
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
  mocks.record.mockResolvedValue(true);
  mocks.mutate.mockResolvedValue(AsyncResult.success(undefined));
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("section membership registration", () => {
  it("does not file a remote thread when the primary catalog write fails", async () => {
    mocks.record.mockResolvedValue(false);
    expect((await actions.setThreadSection(target, section))._tag).toBe("Failure");
    expect(mocks.mutate).not.toHaveBeenCalled();

    mocks.record.mockResolvedValue(true);
    expect((await actions.setThreadSection(target, section))._tag).toBe("Success");
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("waits for registration acknowledgment before writing membership", async () => {
    let resolve!: (value: boolean) => void;
    const registration = new Promise<boolean>((done) => {
      resolve = done;
    });
    mocks.record.mockReturnValue(registration);
    const filing = actions.setThreadSection(target, section);
    expect(mocks.record).toHaveBeenCalledWith(section, [target.environmentId]);
    expect(mocks.mutate).not.toHaveBeenCalled();
    resolve(true);
    await filing;
    expect(mocks.mutate).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, sectionId: section },
    });
  });

  it("allows moving to General without registering an environment", async () => {
    mocks.shell.mockReturnValue({ sectionId: section });
    mocks.record.mockResolvedValue(false);
    expect((await actions.setThreadSection(target, null))._tag).toBe("Success");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("moving threads into a section", () => {
  const other = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("other"));

  it("files every thread and offers an Undo that restores its previous section", async () => {
    expect(await actions.moveThreadsToSection([target, other], section)).toBe(true);
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.mutate).toHaveBeenCalledWith({
      environmentId: other.environmentId,
      input: { threadId: other.threadId, sectionId: section },
    });
    const notices = vi.mocked(showThreadUndoNotice).mock.calls;
    expect(notices).toHaveLength(2);
    expect(notices[0]?.[0]).toMatchObject({ action: "Moved" });
    // Undo writes the thread's previous section (General) back.
    mocks.shell.mockReturnValue({ sectionId: section });
    await notices[0]![0].undo();
    expect(mocks.mutate).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, sectionId: null },
    });
  });

  it("reports a filing failure instead of silently leaving the section empty", async () => {
    mocks.record.mockResolvedValue(false);
    expect(await actions.moveThreadsToSection([target], section)).toBe(false);
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(showThreadUndoNotice).not.toHaveBeenCalled();
    expect(vi.mocked(stackedThreadToast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Failed to move thread to section" }),
    );
  });
});
