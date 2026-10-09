import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  state.migration = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});
async function render(migration: ServerLifecycleLegacyThreadMigrationPayload) {
  state.migration = migration;
  await act(async () => {
    if (renderer) renderer.update(<LegacyThreadMigrationToast />);
    else renderer = create(<LegacyThreadMigrationToast />);
  });
}

it("replaces a running spinner with a persistent failure and clears it after successful retry", async () => {
  await render({ status: "running", totalThreadCount: 2 });
  await render({ status: "failed", totalThreadCount: 2, pendingThreadCount: 1 });
  expect(state.close).toHaveBeenCalledWith("migration-toast");
  expect(state.add).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "error",
      timeout: 0,
      description: expect.stringContaining("1 thread still needs restoration"),
    }),
  );
  await render({ status: "failed", totalThreadCount: 2, pendingThreadCount: 1 });
  expect(state.add).toHaveBeenCalledTimes(2);
  await render({ status: "complete", totalThreadCount: 2, pendingThreadCount: 0 });
  expect(state.close).toHaveBeenCalledTimes(2);
  expect(state.add).toHaveBeenCalledTimes(2);
});

it("shows a replayed failure without a preceding spinner or an invented pending count", async () => {
  await render({ status: "failed", totalThreadCount: 3 });
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
  await render({ status: "complete", totalThreadCount: 3 });
  expect(state.add).not.toHaveBeenCalled();
  await render({ status: "failed", totalThreadCount: 3, pendingThreadCount: 2 });
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(state.close).toHaveBeenCalledWith("migration-toast");
});
