import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotsReady: false,
  sweep: vi.fn(async (_input: unknown) => []),
  restore: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.snapshotsReady }));
vi.mock("../../state/shell", () => ({ allEnvironmentProjectSnapshotsReadyAtom: {} }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => 1 }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./catalog", () => ({
  useThreadSectionCatalog: () => ({
    available: true,
    sweepEmpty: mocks.sweep,
    restoreAll: mocks.restore,
  }),
}));

import { useEmptySectionCleanup } from "./useEmptySectionCleanup";

const connectedEnvironmentIds = new Set(["remote"]);
const threads: Parameters<typeof useEmptySectionCleanup>[0]["threads"] = [];
let renderer: ReactTestRenderer;
function Probe() {
  useEmptySectionCleanup({ threads, connectedEnvironmentIds });
  return null;
}
const deletionSweeps = () =>
  mocks.sweep.mock.calls
    .map(
      ([input]) =>
        input as {
          visibleEnvironmentIds: ReadonlySet<string> | null;
          isCurrent?: () => boolean;
        },
    )
    .filter((input) => input.visibleEnvironmentIds !== null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.snapshotsReady = false;
  mocks.sweep.mockClear();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("never judges emptiness from a connected but unsynchronized shell", async () => {
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(mocks.sweep).toHaveBeenCalled(); // Occupancy recording remains safe.
  expect(deletionSweeps()).toEqual([]);

  mocks.snapshotsReady = true;
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(59_999));
  expect(deletionSweeps()).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(deletionSweeps()).toHaveLength(1);
  expect(deletionSweeps()[0]!.visibleEnvironmentIds).toEqual(connectedEnvironmentIds);
});

it("invalidates queued sweeps and stops deleting as soon as a shell ceases to be live", async () => {
  mocks.snapshotsReady = true;
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const queued = deletionSweeps()[0]!;
  expect(queued.isCurrent?.()).toBe(true);

  mocks.snapshotsReady = false;
  act(() => renderer.update(<Probe />));
  expect(queued.isCurrent?.()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(deletionSweeps()).toHaveLength(1);

  mocks.snapshotsReady = true;
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(deletionSweeps()).toHaveLength(2);
});
