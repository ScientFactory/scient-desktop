import { act } from "../../test/render";

import { expect, it, vi } from "vite-plus/test";
import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  migration: null as ServerLifecycleLegacyThreadMigrationPayload | null,
  add: vi.fn((_notice: unknown) => "migration-toast"),
  close: vi.fn(),
  listener: null as ((value: ServerLifecycleLegacyThreadMigrationPayload | null) => void) | null,
  unsubscribe: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: typeof state.listener) => {
      state.listener = listener;
      listener?.(state.migration);
      return () => {
        state.listener = null;
        state.unsubscribe();
      };
    },
  },
}));
vi.mock("../state/server", () => ({ primaryServerLegacyThreadMigrationAtom: {} }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.add, close: state.close } }));
import { startLegacyThreadMigrationToast } from "./LegacyThreadMigrationToast";

async function _setupFixture0(_fixture: _Fixture) {
  state.migration = null;
  vi.clearAllMocks();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  _fixture.stop?.();
  _fixture.stop = undefined;
  vi.unstubAllGlobals();
}
async function publish(_fixture: _Fixture, migration: ServerLifecycleLegacyThreadMigrationPayload) {
  await act(() => {
    state.migration = migration;
    if (!_fixture.stop) _fixture.stop = startLegacyThreadMigrationToast();
    else state.listener?.(migration);
  });
}

it("replaces a running spinner with a persistent failure and clears it after successful retry", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await publish(_fixture, { status: "running", totalThreadCount: 2 });
  await publish(_fixture, {
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
  await publish(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 2,
    pendingThreadCount: 1,
  });
  expect(state.add).toHaveBeenCalledTimes(2);
  await publish(_fixture, { status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  expect(state.close).toHaveBeenCalledTimes(2);
  expect(state.add).toHaveBeenCalledTimes(2);
});

it("shows a replayed failure without a preceding spinner or an invented pending count", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await publish(_fixture, { status: "running", failed: true, totalThreadCount: 3 });
  expect(state.add).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      timeout: 0,
      description: expect.stringContaining("could not be verified"),
    }),
  );
  expect(state.close).not.toHaveBeenCalled();
});

it("cleans up on disposal and supports older completion payloads without counts", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await publish(_fixture, { status: "complete", totalThreadCount: 3 });
  expect(state.add).not.toHaveBeenCalled();
  await publish(_fixture, {
    status: "running",
    failed: true,
    totalThreadCount: 3,
    pendingThreadCount: 2,
  });
  _fixture.stop?.();
  _fixture.stop = undefined;
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.close).toHaveBeenCalledWith("migration-toast");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    stop: undefined as (() => void) | undefined,
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
