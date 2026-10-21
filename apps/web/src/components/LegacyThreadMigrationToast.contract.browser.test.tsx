import { render as _fixtureRender, type Screen, act } from "../../test/render";

import { expect, it, vi } from "vite-plus/test";
import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  migration: null as ServerLifecycleLegacyThreadMigrationPayload | null,
  add: vi.fn((_notice: unknown) => "migration-toast"),
  close: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.migration }));
vi.mock("../state/server", () => ({ primaryServerLegacyThreadMigrationAtom: {} }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add, close: state.close } }));
import { LegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";

async function _setupFixture0(_fixture: _Fixture) {
  state.migration = null;
  vi.clearAllMocks();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}
async function render(_fixture: _Fixture, migration: ServerLifecycleLegacyThreadMigrationPayload) {
  state.migration = migration;
  await act(async () => {
    if (!_fixture.root0)
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
    await _fixture.root0.rerender(<LegacyThreadMigrationToast />);
  });
}

it("replaces a running spinner with a persistent failure and clears it after successful retry", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, { status: "running", totalThreadCount: 2 });
  await render(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 2,
    pendingThreadCount: 1,
  });
  expect(state.close).toHaveBeenCalledWith("migration-toast");
  expect(state.add).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "error",
      timeout: 0,
      description: expect.stringContaining("1 thread still needs restoration"),
    }),
  );
  await render(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 2,
    pendingThreadCount: 1,
  });
  expect(state.add).toHaveBeenCalledTimes(2);
  await render(_fixture, { status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  expect(state.close).toHaveBeenCalledTimes(2);
  expect(state.add).toHaveBeenCalledTimes(2);
});

it("shows a replayed failure without a preceding spinner or an invented pending count", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, { status: "running", failed: true, totalThreadCount: 3 });
  expect(state.add).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      timeout: 0,
      description: expect.stringContaining("could not be verified"),
    }),
  );
  expect(state.close).not.toHaveBeenCalled();
});

it("cleans up on unmount and supports older completion payloads without counts", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, { status: "complete", totalThreadCount: 3 });
  expect(state.add).not.toHaveBeenCalled();
  await render(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 3,
    pendingThreadCount: 2,
  });
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  expect(state.close).toHaveBeenCalledWith("migration-toast");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
