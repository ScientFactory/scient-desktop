// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let runtime: ReturnType<typeof useComputeManagedRuntime>;
  function Harness() {
    const current = useComputeManagedRuntime({
      environmentId: EnvironmentId.make("test"),
      languageId: ComputeLanguageId.make("python"),
      initialStatus: mocks.initialStatus,
      ensureEnabled: async () => true,
    });
    useLayoutEffect(() => {
      runtime = current;
    }, [current]);
    return null;
  }
  const render = async () => {
    await act(() => root.render(<Harness />));
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.query = absent;
    mocks.isSuccess = true;
    mocks.initialStatus = installed;
    mocks.manage.mockReset().mockResolvedValue({ _tag: "Success", value: installing });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it("retires superseded command receipts permanently, including return to the original state", async () => {
    await render();
    await act(async () => {
      await runtime.act("install");
    });
    expect(runtime.status).toEqual(installing);
    mocks.query = installed;
    await render();
    expect(runtime.status).toEqual(installed);
    mocks.query = absent;
    await render();
    expect(runtime.status).toEqual(absent);
    expect(runtime.busy).toBe(false);
  });
  it("does not resurrect initial inventory after authoritative absence", async () => {
    mocks.query = null;
    await render();
    expect(runtime.status).toBeNull();
  });
  it("keeps inventory while the first query is loading", async () => {
    mocks.query = null;
    mocks.isSuccess = false;
    await render();
    expect(runtime.status).toEqual(installed);
    mocks.isSuccess = true;
    await render();
    expect(runtime.status).toBeNull();
  });
  it("does not allow setup before the first status observation", async () => {
    mocks.query = null;
    mocks.initialStatus = null;
    mocks.isSuccess = false;
    await render();
    expect(runtime.busy).toBe(true);
    await act(async () => {
      expect(await runtime.act("install")).toBe(false);
    });
    expect(mocks.manage).not.toHaveBeenCalled();
    mocks.query = absent;
    mocks.isSuccess = true;
    await render();
    expect(runtime.busy).toBe(false);
  });
  it("keeps an accepted operation through an empty refetch, then accepts completion", async () => {
    await render();
    await act(async () => {
      await runtime.act("install");
    });
    mocks.query = null;
    mocks.isSuccess = false;
    await render();
    expect(runtime.status).toEqual(installing);
    expect(runtime.busy).toBe(true);
    mocks.query = installed;
    mocks.isSuccess = true;
    await render();
    expect(runtime.status).toEqual(installed);
    expect(runtime.busy).toBe(false);
  });
  it("accepts metadata-only server changes after a command receipt", async () => {
    mocks.query = installed;
    mocks.manage.mockResolvedValue({
      _tag: "Success",
      value: { ...installed, selection: "managed" },
    });
    await render();
    await act(async () => {
      await runtime.act("use-managed");
    });
    expect(runtime.status?.selection).toBe("managed");
    mocks.query = { ...installed, updateAvailable: true };
    await render();
    expect(runtime.status?.updateAvailable).toBe(true);
    expect(runtime.status?.selection).toBe("existing");
  });
});
