import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { useLayoutEffect } from "react";

import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScientProjectInspection } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/scientProjectInitialization", () => ({
  inspectScientProjectForOpening: mocks.inspect,
  initializeScientProjectForOpening: vi.fn(),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../state/session", () => ({ readPreparedConnection: () => ({}) }));
import { useScientProjectInitialization } from "./useScientProjectInitialization";

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const initialization = useScientProjectInitialization();
  useLayoutEffect(() => {
    _fixture.publishApi(initialization);
  });
  return null;
}
const input = {
  environmentId: "local" as EnvironmentId,
  prepared: {} as PreparedConnection,
  root: "/project",
};
async function _setupFixture0(_fixture: _Fixture) {
  mocks.inspect.mockReset();
  mocks.toast.mockClear();
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

it.each(["initialize", "open-only", "cancel"] as const)(
  "preserves the %s setup choice",
  async (decision) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.inspect.mockResolvedValue({ root: "/canonical", state: "ordinary" });
    let pending!: ReturnType<typeof _fixture.api.prepareForOpening>;
    await act(() => {
      pending = _fixture.api.prepareForOpening(input);
    });
    expect(_fixture.api.inspection?.root).toBe("/canonical");
    await act(() => _fixture.api.resolveDecision(decision));
    expect(await pending).toEqual(
      decision === "cancel" ? null : { root: "/canonical", initialize: decision === "initialize" },
    );
  },
);
it.each([false, true])(
  "does not surface stale inspection or errors (failure: %s)",
  async (fails) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let resolve!: (value: Partial<ScientProjectInspection>) => void;
    let reject!: (error: Error) => void;
    mocks.inspect.mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    let current = true;
    const pending = _fixture.api.prepareForOpening({ ...input, isCurrent: () => current });
    current = false;
    await act(async () => {
      if (fails) reject(new Error("Inspection timed out"));
      else resolve({ root: "/project", state: "ordinary" });
      expect(await pending).toBeNull();
    });
    expect(_fixture.api.inspection).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  },
);
it("cancels an unresolved setup choice on unmount", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.inspect.mockResolvedValue({ root: "/project", state: "ordinary" });
  let pending!: ReturnType<typeof _fixture.api.prepareForOpening>;
  await act(() => {
    pending = _fixture.api.prepareForOpening(input);
  });
  await act(async () => await _fixture.root0.rerender(null));
  expect(await pending).toBeNull();
});

function _createFixture() {
  let _published_api = undefined! as ReturnType<typeof useScientProjectInitialization>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get api() {
      return _published_api;
    },
    publishApi(next: typeof _published_api) {
      _published_api = next;
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
