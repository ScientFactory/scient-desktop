import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import {
  ComputeSessionId,
  ComputeSessionGeneration,
  EnvironmentId,
  type ComputeSessionRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComputeSavedFileAction } from "./ComputeSavedFileAction";
import {
  ComputeContextId,
  ensureComputeContext,
  useComputeContextStore,
} from "./computeContextStore";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}

async function mount(_fixture: _Fixture, node: ReactNode) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await act(async () => await _fixture.root0!.rerender(node));
  return _fixture.host;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0!.unmount());
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const mocks = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.read }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("~/state/compute", () => ({ computeEnvironment: { submitExecution: Symbol("submit") } }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { readFile: Symbol("read") } }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/components/files/ProjectFilePicker", () => ({
  ProjectFilePickerForTarget: (props: {
    target: unknown;
    onSelectFile: (path: string) => void;
  }) => {
    expect(props.target).toMatchObject({ environmentId, cwd: "/synthetic" });
    return <button onClick={() => props.onSelectFile("run.py")}>Select run.py</button>;
  },
}));

const contextId = ComputeContextId.make("standalone-test");
const sessionId = ComputeSessionId.make("owned-session");
const generation = ComputeSessionGeneration.make(1);
const environmentId = EnvironmentId.make("env");
const session = {
  sessionId,
  generation,
  status: "ready",
  languageId: "python",
  label: "Python",
} as ComputeSessionRecord;
const props = {
  contextId,
  session,
  environmentId,
  cwd: "/synthetic",
  threadRef: {} as ScopedThreadRef,
  disabled: false,
  onSubmitted: vi.fn(),
};
const saved = {
  relativePath: "run.py",
  contents: "print(42)\n",
  revision: "saved-revision",
  truncated: false,
  byteLength: 10,
};

async function pickFile(_fixture: _Fixture) {
  await mount(_fixture, <ComputeSavedFileAction {...props} open onOpenChange={() => undefined} />);
  const picker = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Select run.py",
  );
  expect(picker).toBeDefined();
  await act(() => picker!.click());
}

async function _setupFixture2(_fixture: _Fixture) {
  vi.clearAllMocks();
  useComputeContextStore.setState({ bindings: {} });
  ensureComputeContext({ contextId, environmentId, cwd: "/synthetic" });
  useComputeContextStore.getState().reserveSession({ contextId, sessionId, generation });
  useComputeContextStore.getState().bindSession({ contextId, sessionId, generation });
}

describe("standalone saved-file action", () => {
  it("submits freshly read bytes to this exact session, not another file tab", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.read.mockResolvedValue({ _tag: "Success", value: saved });
    mocks.submit.mockResolvedValue({ _tag: "Success", value: { request: { sessionId } } });
    await pickFile(_fixture);
    await vi.waitFor(() => expect(props.onSubmitted).toHaveBeenCalledOnce());
    expect(mocks.submit).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        cwd: "/synthetic",
        sessionId,
        expectedGeneration: generation,
        code: saved.contents,
        source: expect.objectContaining({ bufferState: "saved", revision: saved.revision }),
      }),
    });
  });
  it("does not submit when Stop takes ownership during the file read", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    let resolveRead!: (value: unknown) => void;
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    mocks.read.mockReturnValue(pendingRead);
    await pickFile(_fixture);
    useComputeContextStore.getState().markClosing(contextId);
    resolveRead({ _tag: "Success", value: saved });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("reports a read failure without running or replacing the session", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    mocks.read.mockRejectedValue(new Error("File removed"));
    await pickFile(_fixture);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "File removed" }),
      ),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[contextId]?.sessionId).toBe(sessionId);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
