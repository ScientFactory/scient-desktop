// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScientProjectInspection } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/scientProjectInitialization", () => ({
  inspectScientProjectForOpening: mocks.inspect,
  initializeScientProjectForOpening: vi.fn(),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../state/session", () => ({ readPreparedConnection: () => ({}) }));
import { useScientProjectInitialization } from "./useScientProjectInitialization";
let root: Root;
let container: HTMLDivElement;
let api!: ReturnType<typeof useScientProjectInitialization>;
function Probe() {
  const initialization = useScientProjectInitialization();
  useLayoutEffect(() => {
    api = initialization;
  });
  return null;
}
const input = {
  environmentId: "local" as EnvironmentId,
  prepared: {} as PreparedConnection,
  root: "/project",
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.inspect.mockReset();
  mocks.toast.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Probe />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["initialize", "open-only", "cancel"] as const)(
  "preserves the %s setup choice",
  async (decision) => {
    mocks.inspect.mockResolvedValue({ root: "/canonical", state: "ordinary" });
    let pending!: ReturnType<typeof api.prepareForOpening>;
    await act(() => {
      pending = api.prepareForOpening(input);
    });
    expect(api.inspection?.root).toBe("/canonical");
    await act(() => api.resolveDecision(decision));
    expect(await pending).toEqual(
      decision === "cancel" ? null : { root: "/canonical", initialize: decision === "initialize" },
    );
  },
);
it.each([false, true])(
  "does not surface stale inspection or errors (failure: %s)",
  async (fails) => {
    let resolve!: (value: Partial<ScientProjectInspection>) => void;
    let reject!: (error: Error) => void;
    mocks.inspect.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    let current = true;
    const pending = api.prepareForOpening({ ...input, isCurrent: () => current });
    current = false;
    await act(async () => {
      if (fails) reject(new Error("Inspection timed out"));
      else resolve({ root: "/project", state: "ordinary" });
      expect(await pending).toBeNull();
    });
    expect(api.inspection).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  },
);
it("cancels an unresolved setup choice on unmount", async () => {
  mocks.inspect.mockResolvedValue({ root: "/project", state: "ordinary" });
  let pending!: ReturnType<typeof api.prepareForOpening>;
  await act(() => {
    pending = api.prepareForOpening(input);
  });
  await act(() => root.render(null));
  expect(await pending).toBeNull();
});
