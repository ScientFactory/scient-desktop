// @vitest-environment happy-dom
import { useAnswerBaselines } from "./baseline";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../../uiStateStore";
import { ScientAnswerBadgeCoordinator } from "./ScientAnswerBadgeCoordinator";

const mock = vi.hoisted(() => ({ snapshot: {} as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mock.snapshot }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/shell", () => ({ environmentShell: {} }));
let root: Root;
const badge = vi.fn(async (_count: number) => true);
const before = "2026-09-09T09:00:00.000Z";
const after = "2026-09-09T10:00:00.000Z";
const thread = (id: string, completedAt = before, archivedAt: string | null = null) => ({
  id,
  archivedAt,
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
    snapshot: Option.some({ threads, updatedAt: before } as unknown as OrchestrationShellSnapshot),
  },
});
const render = (environments: ReturnType<typeof environment>[]) => {
  mock.snapshot = { ready: true, environments };
  return act(() => root.render(<ScientAnswerBadgeCoordinator />));
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "desktopBridge", {
    value: { setUnreadAnswerCount: badge },
    configurable: true,
  });
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  badge.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it("ignores historical answers, counts conversations across environments, and preserves queued completions", async () => {
  await render([
    environment("local-a", [thread("same")]),
    environment("remote-a", [thread("same")]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(0);
  expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
  await render([
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after)]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(2);
  const calls = badge.mock.calls.length;
  await render([
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after)], "cached"),
  ]);
  expect(badge.mock.calls).toHaveLength(calls);
  const key = scopedThreadKey(scopeThreadRef(EnvironmentId.make("local-a"), "same" as never));
  await act(() => useUiStateStore.getState().markThreadVisited(key, after));
  expect(badge).toHaveBeenLastCalledWith(1);
  await render([
    environment("local-a", [thread("same", after)]),
    environment("remote-a", [thread("same", after, after)]),
  ]);
  expect(badge).toHaveBeenLastCalledWith(0);
});
it("counts newly created conversations and clears removed environments without blocking on an offline one", async () => {
  await render([environment("local-b", [])]);
  await render([environment("local-b", [thread("new", after)])]);
  expect(badge).toHaveBeenLastCalledWith(1);
  await render([environment("local-b", [])]);
  expect(badge).toHaveBeenLastCalledWith(0);
});

it("retains unread answers from cached offline snapshots without writing visits", async () => {
  useAnswerBaselines.setState({ byEnvironment: { "offline-c": before } });
  await render([environment("offline-c", [thread("waiting", after)], "cached")]);
  expect(badge).toHaveBeenLastCalledWith(1);
  expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
});
