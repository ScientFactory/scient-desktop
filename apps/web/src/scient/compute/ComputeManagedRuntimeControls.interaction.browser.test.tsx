import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  EnvironmentId,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  query: null as ComputeManagedRuntimeStatus | null,
  isSuccess: true,
  initialStatus: null as ComputeManagedRuntimeStatus | null,
  manage: vi.fn(),
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    managedRuntime: () => "status",
    manageRuntime: "manage",
    cancelManagedRuntime: "cancel",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.query,
    isSuccess: mocks.isSuccess,
    isPending: !mocks.isSuccess,
    error: null,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.manage }));

import { useComputeManagedRuntime } from "./ComputeManagedRuntimeControls";

const absent: ComputeManagedRuntimeStatus = {
  installed: false,
  selection: "existing",
  updateAvailable: false,
  runtimeVersion: null,
  toolkitRevision: null,
  generationId: null,
  operation: null,
  failureMessage: null,
};
const installing: ComputeManagedRuntimeStatus = {
  ...absent,
  operation: {
    operationId: "install-1",
    action: "install",
    phase: "installing-python",
    startedAt: "2026-09-14T12:00:00.000Z",
    downloadedBytes: null,
    totalBytes: null,
  },
};
const installed: ComputeManagedRuntimeStatus = { ...absent, installed: true, generationId: "g1" };

describe("managed runtime observation ownership", () => {
  function Harness({ _fixture }: { _fixture: _Fixture }) {
    const current = useComputeManagedRuntime({
      environmentId: EnvironmentId.make("test"),
      languageId: ComputeLanguageId.make("python"),
      initialStatus: mocks.initialStatus,
      ensureEnabled: async () => true,
    });
    useLayoutEffect(() => {
      _fixture.publishRuntime(current);
    }, [_fixture, current]);
    return null;
  }
  const render = async (_fixture: _Fixture) => {
    await act(async () => await _fixture.root0.rerender(<Harness _fixture={_fixture} />));
  };
  async function _setupFixture0(_fixture: _Fixture) {
    mocks.query = absent;
    mocks.isSuccess = true;
    mocks.initialStatus = installed;
    mocks.manage.mockReset().mockResolvedValue({ _tag: "Success", value: installing });
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  it("retires superseded command receipts permanently, including return to the original state", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(async () => {
      await _fixture.runtime.act("install");
    });
    expect(_fixture.runtime.status).toEqual(installing);
    mocks.query = installed;
    await render(_fixture);
    expect(_fixture.runtime.status).toEqual(installed);
    mocks.query = absent;
    await render(_fixture);
    expect(_fixture.runtime.status).toEqual(absent);
    expect(_fixture.runtime.busy).toBe(false);
  });
  it("does not resurrect initial inventory after authoritative absence", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.query = null;
    await render(_fixture);
    expect(_fixture.runtime.status).toBeNull();
  });
  it("keeps inventory while the first query is loading", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.query = null;
    mocks.isSuccess = false;
    await render(_fixture);
    expect(_fixture.runtime.status).toEqual(installed);
    mocks.isSuccess = true;
    await render(_fixture);
    expect(_fixture.runtime.status).toBeNull();
  });
  it("does not allow setup before the first status observation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.query = null;
    mocks.initialStatus = null;
    mocks.isSuccess = false;
    await render(_fixture);
    expect(_fixture.runtime.busy).toBe(true);
    await act(async () => {
      expect(await _fixture.runtime.act("install")).toBe(false);
    });
    expect(mocks.manage).not.toHaveBeenCalled();
    mocks.query = absent;
    mocks.isSuccess = true;
    await render(_fixture);
    expect(_fixture.runtime.busy).toBe(false);
  });
  it("keeps an accepted operation through an empty refetch, then accepts completion", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(async () => {
      await _fixture.runtime.act("install");
    });
    mocks.query = null;
    mocks.isSuccess = false;
    await render(_fixture);
    expect(_fixture.runtime.status).toEqual(installing);
    expect(_fixture.runtime.busy).toBe(true);
    mocks.query = installed;
    mocks.isSuccess = true;
    await render(_fixture);
    expect(_fixture.runtime.status).toEqual(installed);
    expect(_fixture.runtime.busy).toBe(false);
  });
  it("accepts metadata-only server changes after a command receipt", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.query = installed;
    mocks.manage.mockResolvedValue({
      _tag: "Success",
      value: { ...installed, selection: "managed" },
    });
    await render(_fixture);
    await act(async () => {
      await _fixture.runtime.act("use-managed");
    });
    expect(_fixture.runtime.status?.selection).toBe("managed");
    mocks.query = { ...installed, updateAvailable: true };
    await render(_fixture);
    expect(_fixture.runtime.status?.updateAvailable).toBe(true);
    expect(_fixture.runtime.status?.selection).toBe("existing");
  });
});

function _createFixture() {
  let _published_runtime = undefined! as ReturnType<typeof useComputeManagedRuntime>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get runtime() {
      return _published_runtime;
    },
    publishRuntime(next: typeof _published_runtime) {
      _published_runtime = next;
    },

    container: undefined! as HTMLDivElement,
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
