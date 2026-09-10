// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { useAcknowledgeAnswer } from "./useAcknowledgeAnswer";

const { markThreadVisited } = vi.hoisted(() => ({ markThreadVisited: vi.fn() }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ markThreadVisited }) },
}));
let root: Root;
let focused = false;
let visibility = "visible";
const completedAt = "2026-09-09T10:00:00.000Z";
const thread = (loaded = true) =>
  ({
    environmentId: "local",
    id: "one",
    latestCompletedAnswer: { turnId: "turn", messageId: "reply", completedAt },
    latestTurn: { state: "running" },
    messages: loaded ? [{ id: "reply", role: "assistant", streaming: false }] : [],
  }) as unknown as EnvironmentThread;
function Probe({ value }: { value: EnvironmentThread | null }) {
  useAcknowledgeAnswer(value);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  focused = false;
  visibility = "visible";
  markThreadVisited.mockClear();
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("leaves a selected background conversation unread until focus returns", async () => {
  await act(() => root.render(<Probe value={thread()} />));
  expect(markThreadVisited).not.toHaveBeenCalled();
  focused = true;
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(markThreadVisited).toHaveBeenLastCalledWith(expect.any(String), completedAt);
});
it("waits for the completed assistant message, even when the shell arrives first", async () => {
  focused = true;
  await act(() => root.render(<Probe value={thread(false)} />));
  expect(markThreadVisited).not.toHaveBeenCalled();
  await act(() => root.render(<Probe value={thread()} />));
  expect(markThreadVisited).toHaveBeenCalledTimes(1);
});
it("does not acknowledge hidden content or a conversation after navigation away", async () => {
  focused = true;
  visibility = "hidden";
  await act(() => root.render(<Probe value={thread()} />));
  expect(markThreadVisited).not.toHaveBeenCalled();
  await act(() => root.render(<Probe value={null} />));
  visibility = "visible";
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(markThreadVisited).not.toHaveBeenCalled();
});
