import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type SweepInput = {
  readonly occupancy: ReadonlyMap<string, ReadonlySet<string>>;
  readonly judge: boolean;
  readonly afterDays: number;
  readonly isCurrent?: () => boolean;
};

const mocks = vi.hoisted(() => ({
  configsAtom: { atom: "configs" },
  loadedAtom: { atom: "loaded" },
  loadedKey: "",
  cleanupDays: new Map<string, number | null>(),
  sweep: vi.fn(async (_environmentId: string, _input: unknown): Promise<unknown[]> => []),
  restore: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === mocks.configsAtom
      ? new Map(
          [...mocks.cleanupDays].map(([id, days]) => [
            id,
            { settings: { threadSectionsDeleteEmptyAfterDays: days } },
          ]),
        )
      : mocks.loadedKey,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: mocks.configsAtom }));
vi.mock("./loadedEnvironments", () => ({ loadedThreadEnvironmentsKeyAtom: mocks.loadedAtom }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({
    catalogs: [{ environmentId: "primary" }, { environmentId: "remote" }],
    sweepEmpty: mocks.sweep,
    restoreAll: mocks.restore,
  }),
}));

import { useEmptySectionCleanup } from "./useEmptySectionCleanup";

const threads: Parameters<typeof useEmptySectionCleanup>[0]["threads"] = [
  { environmentId: "primary", sectionId: "papers", archivedAt: null },
  { environmentId: "remote", sectionId: "runs", archivedAt: null },
  // Archived threads never keep a section.
  { environmentId: "remote", sectionId: "old", archivedAt: "2026-01-01T00:00:00.000Z" },
];
let renderer: ReactTestRenderer;
function Probe() {
  useEmptySectionCleanup({ threads });
  return null;
}
const sweeps = (judge: boolean) =>
  mocks.sweep.mock.calls
    .map(([environmentId, input]) => ({ environmentId, ...(input as SweepInput) }))
    .filter((call) => call.judge === judge);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.loadedKey = "";
  mocks.cleanupDays = new Map([
    ["primary", 1],
    ["remote", 3],
  ]);
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("records each environment's occupancy from its own threads only", () => {
  const recorded = sweeps(false);
  expect(recorded.map((call) => call.environmentId).toSorted()).toEqual(["primary", "remote"]);
  const byEnvironment = new Map(recorded.map((call) => [call.environmentId, call.occupancy]));
  expect(byEnvironment.get("primary")).toEqual(new Map([["papers", new Set(["primary"])]]));
  expect(byEnvironment.get("remote")).toEqual(new Map([["runs", new Set(["remote"])]]));
});

it("judges an environment only once its live thread list has held for a minute", async () => {
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(sweeps(true)).toEqual([]);

  mocks.loadedKey = "remote";
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(59_999));
  expect(sweeps(true)).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  // Only the loaded environment, with its own setting.
  expect(sweeps(true)).toEqual([
    expect.objectContaining({ environmentId: "remote", afterDays: 3 }),
  ]);
});

it("leaves an environment alone while its cleanup is off", async () => {
  mocks.cleanupDays.set("primary", null);
  mocks.loadedKey = "primary\nremote";
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(sweeps(true).map((call) => call.environmentId)).toEqual(["remote"]);
});

it("invalidates queued sweeps and stops deleting as soon as a thread list ceases to be live", async () => {
  mocks.loadedKey = "remote";
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const queued = sweeps(true)[0]!;
  expect(queued.isCurrent?.()).toBe(true);

  mocks.loadedKey = "";
  act(() => renderer.update(<Probe />));
  expect(queued.isCurrent?.()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(sweeps(true)).toHaveLength(1);
});

it("offers Undo that restores the removed sections on their environment", async () => {
  const removed = [{ section: { id: "runs", name: "Runs", order: 0 }, index: 0, generalIndex: 0 }];
  mocks.sweep.mockImplementation(async (_environmentId, input) =>
    (input as SweepInput).judge ? removed : [],
  );
  mocks.loadedKey = "remote";
  act(() => renderer.update(<Probe />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const toast = mocks.toast.mock.calls[0]![0] as {
    title: string;
    actionProps: { onClick: () => void };
  };
  expect(toast.title).toBe("Removed empty section “Runs”");
  toast.actionProps.onClick();
  expect(mocks.restore).toHaveBeenCalledWith("remote", removed);
});
