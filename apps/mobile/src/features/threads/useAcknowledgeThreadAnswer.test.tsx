// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, MessageId, RunId, TurnId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { makeThreadShellFixture } from "../../test-fixtures";
import { useAcknowledgeThreadAnswer } from "./useAcknowledgeThreadAnswer";

const native = vi.hoisted(() => ({
  state: "active",
  listeners: new Set<() => void>(),
  visit: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: () => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: Symbol("visit") } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => native.visit }));
const answer = {
  turnId: TurnId.make("answer-run"),
  messageId: MessageId.make("answer"),
  completedAt: "2026-10-04T10:00:00.000Z",
};
function thread(): EnvironmentThreadShell {
  return makeThreadShellFixture({
    latestCompletedAnswer: answer,
    lastVisitedAt: "2026-10-04T09:00:00.000Z",
    updatedAt: "2026-10-04T12:00:00.000Z",
  });
}
function feed(text = "Answer", streaming = false): ThreadFeedEntry[] {
  const value = thread();
  return [
    {
      type: "message",
      id: "answer",
      createdAt: answer.completedAt,
      message: {
        id: answer.messageId,
        role: "assistant",
        text,
        attachments: [],
        runId: RunId.make("answer-run"),
        streaming,
        visibility: "local",
        sourceThreadId: value.id,
        createdAt: answer.completedAt,
        updatedAt: answer.completedAt,
      },
    },
  ];
}
function Probe({
  value = thread(),
  rows = feed(),
  visible = true,
}: {
  value?: EnvironmentThreadShell;
  rows?: ReadonlyArray<ThreadFeedEntry>;
  visible?: boolean;
}) {
  useAcknowledgeThreadAnswer(EnvironmentId.make("local"), value, rows, visible);
  return null;
}
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.state = "active";
  native.visit.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  expect(native.listeners.size).toBe(0);
  vi.unstubAllGlobals();
});
it("waits for the exact completed answer before publishing its server watermark", async () => {
  await act(() => root.render(<Probe rows={[]} />));
  expect(native.visit).not.toHaveBeenCalled();
  await act(() => root.render(<Probe />));
  expect(native.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: {
      threadId: thread().id,
      visitedAt: answer.completedAt,
    },
  });
});
it.each([
  ["\t\n\u00a0", false],
  ["Streaming", true],
] as const)("does not read unsettled or blank content %j/%j", async (text, streaming) => {
  await act(() => root.render(<Probe rows={feed(text, streaming)} />));
  expect(native.visit).not.toHaveBeenCalled();
});
it("requires native foreground and an actually visible detail screen", async () => {
  native.state = "background";
  await act(() => root.render(<Probe />));
  expect(native.visit).not.toHaveBeenCalled();
  native.state = "active";
  await act(() => {
    for (const listener of native.listeners) listener();
  });
  expect(native.visit).toHaveBeenCalledTimes(1);
  await act(() =>
    root.render(
      <Probe visible={false} value={{ ...thread(), id: ThreadId.make("hidden-thread") }} />,
    ),
  );
  await act(() => {
    for (const listener of native.listeners) listener();
  });
  expect(native.visit).toHaveBeenCalledTimes(1);
});
it("does not restore explicit-null answer attention from a completed run or inherited feed row", async () => {
  await act(() =>
    root.render(
      <Probe
        value={{
          ...thread(),
          latestCompletedAnswer: null,
          latestRun: {
            runId: RunId.make("answerless"),
            status: "completed",
            requestedAt: null,
            startedAt: null,
            completedAt: "2026-10-04T12:00:00.000Z",
            assistantMessageId: null,
          },
        }}
      />,
    ),
  );
  expect(native.visit).not.toHaveBeenCalled();
});
it("does not redispatch an already acknowledged answer after mark-unread", async () => {
  await act(() => root.render(<Probe />));
  await act(() =>
    root.render(<Probe value={{ ...thread(), lastVisitedAt: "2026-10-04T08:00:00.000Z" }} />),
  );
  native.state = "background";
  native.state = "active";
  await act(() => {
    for (const listener of native.listeners) listener();
  });
  expect(native.visit).toHaveBeenCalledTimes(1);
});

it("acknowledges an exact loaded legacy answer only when canonical data is absent", async () => {
  const latestRun = {
    runId: RunId.make("answer-run"),
    status: "completed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt: answer.completedAt,
    assistantMessageId: answer.messageId,
  };
  await act(() =>
    root.render(<Probe value={{ ...thread(), latestRun, latestCompletedAnswer: null }} />),
  );
  expect(native.visit).not.toHaveBeenCalled();
  await act(() =>
    root.render(<Probe value={{ ...thread(), latestRun, latestCompletedAnswer: undefined }} />),
  );
  expect(native.visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: {
      threadId: thread().id,
      visitedAt: answer.completedAt,
    },
  });
});
it("keeps mark-unread sticky even if the answer was already read when opened", async () => {
  await act(() =>
    root.render(<Probe value={{ ...thread(), lastVisitedAt: answer.completedAt }} />),
  );
  expect(native.visit).not.toHaveBeenCalled();
  await act(() => root.render(<Probe />));
  await act(() => {
    for (const listener of native.listeners) listener();
  });
  expect(native.visit).not.toHaveBeenCalled();
});
it("retries a failed visit only on the next native foreground signal", async () => {
  native.visit.mockResolvedValueOnce({ _tag: "Failure" });
  await act(() => root.render(<Probe />));
  expect(native.visit).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Probe />));
  expect(native.visit).toHaveBeenCalledTimes(1);
  await act(() => {
    for (const listener of native.listeners) listener();
  });
  expect(native.visit).toHaveBeenCalledTimes(2);
});

it("can acknowledge mark-unread after the detail screen is reopened", async () => {
  await act(() => root.render(<Probe />));
  await act(() => root.render(<Probe visible={false} />));
  await act(() => root.render(<Probe />));
  expect(native.visit).toHaveBeenCalledTimes(2);
});

it("resets answer dedupe across an answerless conversation without remounting", async () => {
  await act(() => root.render(<Probe />));
  await act(() =>
    root.render(<Probe rows={[]} value={{ ...thread(), id: ThreadId.make("answerless-b") }} />),
  );
  expect(native.visit).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Probe />));
  expect(native.visit).toHaveBeenCalledTimes(2);
});
