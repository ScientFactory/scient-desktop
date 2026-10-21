import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useAnswerBaselines } from "./baseline";

import { expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../../uiStateStore";
import { ScientAnswerBadgeCoordinator } from "./ScientAnswerBadgeCoordinator";

const mock = vi.hoisted(() => ({ snapshot: {} as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mock.snapshot }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/shell", () => ({ environmentShell: {} }));

const badge = vi.fn(async (_count: number) => true);
const before = "2026-09-09T09:00:00.000Z";
const after = "2026-09-09T10:00:00.000Z";
const thread = (id: string, completedAt = before, archivedAt: string | null = null) => ({
  id,
  archivedAt,
  updatedAt: before,
  latestCompletedAnswer: { turnId: "turn", messageId: "answer", completedAt },
  latestTurn: { state: "running" },
});
const environment = (
  environmentId: string,
  threads: ReturnType<typeof thread>[],
  status = "live",
) => ({
  environmentId: EnvironmentId.make(environmentId),
  shell: {
    status,
    snapshot: Option.some({
      threads,
      archivedThreads: [],
    } as unknown as OrchestrationV2ShellSnapshot),
  },
});
const render = async (_fixture: _Fixture, environments: ReturnType<typeof environment>[]) => {
  mock.snapshot = { ready: true, environments };
  return await act(async () => await _fixture.root0.rerender(<ScientAnswerBadgeCoordinator />));
};
async function _setupFixture0(_fixture: _Fixture) {
  Object.defineProperty(window, "desktopBridge", {
    value: { setUnreadAnswerCount: badge },
    configurable: true,
  });
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  badge.mockClear();
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: document.createElement("div"), router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.unstubAllGlobals();
}
it("ignores historical answers, counts conversations across environments, and preserves queued completions", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, [
    environment("local-a", [thread("same")]),
    environment("remote-a", [thread("same")]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(0);
  expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
  await render(_fixture, [
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after)]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(2);
  const calls = badge.mock.calls.length;
  await render(_fixture, [
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after)], "cached"),
  ]);
  expect(badge.mock.calls).toHaveLength(calls);
  const key = scopedThreadKey(scopeThreadRef(EnvironmentId.make("local-a"), "same" as never));
  await act(() => useUiStateStore.getState().markThreadVisited(key, after));
  expect(badge).toHaveBeenLastCalledWith(1);
  await render(_fixture, [
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after, after)]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(0);
});
it("counts newly created conversations and clears removed environments without blocking on an offline one", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, [environment("local-b", [])]);
  await render(_fixture, [environment("local-b", [thread("new", after)])]);
  expect(badge).toHaveBeenLastCalledWith(1);
  await render(_fixture, [environment("local-b", [])]);
  expect(badge).toHaveBeenLastCalledWith(0);
});

it("retains unread answers from cached offline snapshots without writing visits", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  useAnswerBaselines.setState({ byEnvironment: { "offline-c": before } });
  await render(_fixture, [environment("offline-c", [thread("waiting", after)], "cached")]);
  expect(badge).toHaveBeenLastCalledWith(1);
  expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
