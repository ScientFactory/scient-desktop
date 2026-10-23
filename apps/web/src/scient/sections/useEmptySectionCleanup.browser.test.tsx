import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";

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

function Probe({ _fixture }: { _fixture: _Fixture }) {
  useEmptySectionCleanup({ threads: _fixture.threads });
  return null;
}
const sweeps = (judge: boolean) =>
  mocks.sweep.mock.calls
    .map(([environmentId, input]) => ({ environmentId, ...(input as SweepInput) }))
    .filter((call) => call.judge === judge);

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());

  vi.clearAllMocks();
  mocks.loadedKey = "";
  mocks.cleanupDays = new Map([
    ["primary", 1],
    ["remote", 3],
  ]);
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

it("records each environment's occupancy from its own threads only", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const recorded = sweeps(false);
  expect(recorded.map((call) => call.environmentId).toSorted()).toEqual(["primary", "remote"]);
  const byEnvironment = new Map(recorded.map((call) => [call.environmentId, call.occupancy]));
  expect(byEnvironment.get("primary")).toEqual(new Map([["papers", new Set(["primary"])]]));
  expect(byEnvironment.get("remote")).toEqual(new Map([["runs", new Set(["remote"])]]));
});

it("judges an environment only once its live thread list has held for a minute", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(sweeps(true)).toEqual([]);

  mocks.loadedKey = "remote";
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  await act(() => vi.advanceTimersByTimeAsync(59_999));
  expect(sweeps(true)).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  // Only the loaded environment, with its own setting.
  expect(sweeps(true)).toEqual([
    expect.objectContaining({ environmentId: "remote", afterDays: 3 }),
  ]);
});

it("leaves an environment alone while its cleanup is off", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.cleanupDays.set("primary", null);
  mocks.loadedKey = "primary\nremote";
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(sweeps(true).map((call) => call.environmentId)).toEqual(["remote"]);
});

it("invalidates queued sweeps and stops deleting as soon as a thread list ceases to be live", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.loadedKey = "remote";
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const queued = sweeps(true)[0]!;
  expect(queued.isCurrent?.()).toBe(true);

  mocks.loadedKey = "";
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  expect(queued.isCurrent?.()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(sweeps(true)).toHaveLength(1);
});

it("offers Undo that restores the removed sections on their environment", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const removed = [{ section: { id: "runs", name: "Runs", order: 0 }, index: 0, generalIndex: 0 }];
  mocks.sweep.mockImplementation(async (_environmentId, input) =>
    (input as SweepInput).judge ? removed : [],
  );
  mocks.loadedKey = "remote";
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const toast = mocks.toast.mock.calls[0]![0] as {
    title: string;
    actionProps: { onClick: () => void };
  };
  expect(toast.title).toBe("Removed empty section “Runs”");
  toast.actionProps.onClick();
  expect(mocks.restore).toHaveBeenCalledWith("remote", removed);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    threads: [
      { environmentId: "primary", sectionId: "papers", archivedAt: null },
      { environmentId: "remote", sectionId: "runs", archivedAt: null },
      // Archived threads never keep a section.
      { environmentId: "remote", sectionId: "old", archivedAt: "2026-01-01T00:00:00.000Z" },
    ] as Parameters<typeof useEmptySectionCleanup>[0]["threads"],

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
