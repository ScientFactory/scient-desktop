// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, MessageId, NodeId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { useAcknowledgeAnswer } from "./useAcknowledgeAnswer";

const { markThreadVisited, visit } = vi.hoisted(() => ({
  markThreadVisited: vi.fn(),
  visit: vi.fn(),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: Symbol("visit") } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => visit }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ markThreadVisited }) },
}));
let root: Root;
let focused = false;
let visibility = "visible";
const completedAt = DateTime.makeUnsafe("2026-09-09T10:00:00.000Z");
function thread(loaded = true): EnvironmentThread {
  const projection = makeThreadProjectionFixture();
  const run = {
    id: RunId.make("answer-run"),
    threadId: projection.thread.id,
    ordinal: 1,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("question"),
    rootNodeId: NodeId.make("answer-root"),
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    environmentId: EnvironmentId.make("local"),
    projection: {
      ...projection,
      updatedAt: DateTime.makeUnsafe("2026-09-09T12:00:00.000Z"),
      runs: [
        run,
        { ...run, id: RunId.make("new-run"), ordinal: 2, status: "running", completedAt: null },
      ],
      messages: loaded
        ? [
            {
              id: MessageId.make("reply"),
              threadId: projection.thread.id,
              runId: run.id,
              nodeId: run.rootNodeId,
              role: "assistant",
              text: "The completed answer",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: completedAt,
              updatedAt: completedAt,
            },
          ]
        : [],
    },
  };
}
function Probe({ value }: { value: EnvironmentThread | null }) {
  useAcknowledgeAnswer(value);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  focused = false;
  visibility = "visible";
  markThreadVisited.mockClear();
  visit.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
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
  expect(markThreadVisited).toHaveBeenLastCalledWith(
    expect.any(String),
    DateTime.formatIso(completedAt),
  );
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

it("persists the loaded answer watermark instead of newer thread activity", async () => {
  focused = true;
  await act(() => root.render(<Probe value={thread()} />));
  expect(visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: { threadId: "thread-test", visitedAt: DateTime.formatIso(completedAt) },
  });
  const changed = thread();
  await act(() => root.render(<Probe value={changed} />));
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(visit).toHaveBeenCalledTimes(1);
});
it.each(["", "\t\n\u00a0\ufeff"])(
  "does not acknowledge whitespace-only answer %j",
  async (text) => {
    focused = true;
    const value = thread();
    await act(() =>
      root.render(
        <Probe
          value={{
            ...value,
            projection: {
              ...value.projection,
              messages: value.projection.messages.map((message) => ({ ...message, text })),
            },
          }}
        />,
      ),
    );
    expect(markThreadVisited).not.toHaveBeenCalled();
    expect(visit).not.toHaveBeenCalled();
  },
);
it("does not use an unrelated settled assistant to acknowledge an answerless completion", async () => {
  focused = true;
  const value = thread();
  await act(() =>
    root.render(
      <Probe
        value={{
          ...value,
          projection: {
            ...value.projection,
            messages: value.projection.messages.map((message) => ({
              ...message,
              runId: RunId.make("other-run"),
            })),
          },
        }}
      />,
    ),
  );
  expect(markThreadVisited).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
});
it("keeps mark-unread sticky until a different answer or conversation reopen", async () => {
  focused = true;
  const value = thread();
  await act(() => root.render(<Probe value={value} />));
  const rewound = {
    ...value,
    projection: {
      ...value.projection,
      thread: {
        ...value.projection.thread,
        lastVisitedAt: DateTime.makeUnsafe("2026-09-09T09:59:59.000Z"),
      },
    },
  };
  await act(() => root.render(<Probe value={rewound} />));
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(visit).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Probe value={null} />));
  await act(() => root.render(<Probe value={rewound} />));
  expect(visit).toHaveBeenCalledTimes(2);
});
it("establishes empty-conversation visited metadata at creation without using activity", async () => {
  focused = true;
  const projection = makeThreadProjectionFixture();
  await act(() =>
    root.render(<Probe value={{ environmentId: EnvironmentId.make("local"), projection }} />),
  );
  expect(visit).toHaveBeenCalledExactlyOnceWith({
    environmentId: "local",
    input: {
      threadId: projection.thread.id,
      visitedAt: DateTime.formatIso(projection.thread.createdAt),
    },
  });
});

it.each(["completed", "failed", "interrupted"] as const)(
  "acknowledges only the retained earlier answer after an answerless %s run",
  async (status) => {
    focused = true;
    const value = thread();
    await act(() =>
      root.render(
        <Probe
          value={{
            ...value,
            projection: {
              ...value.projection,
              runs: value.projection.runs.map((run) =>
                run.ordinal === 2
                  ? {
                      ...run,
                      status,
                      completedAt: DateTime.makeUnsafe("2026-09-09T12:00:00.000Z"),
                    }
                  : run,
              ),
            },
          }}
        />,
      ),
    );
    expect(visit).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        threadId: value.projection.thread.id,
        visitedAt: DateTime.formatIso(completedAt),
      },
    });
  },
);
it("does not acknowledge a settled assistant owned by a different root", async () => {
  focused = true;
  const value = thread();
  await act(() =>
    root.render(
      <Probe
        value={{
          ...value,
          projection: {
            ...value.projection,
            messages: value.projection.messages.map((message) => ({
              ...message,
              nodeId: NodeId.make("subagent-root"),
            })),
          },
        }}
      />,
    ),
  );
  expect(markThreadVisited).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
});

it("retries a failed server visit on the next focus signal without spinning", async () => {
  focused = true;
  visit.mockResolvedValueOnce({ _tag: "Failure" });
  await act(() => root.render(<Probe value={thread()} />));
  expect(visit).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Probe value={thread()} />));
  expect(visit).toHaveBeenCalledTimes(1);
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(visit).toHaveBeenCalledTimes(2);
  expect(visit).toHaveBeenLastCalledWith({
    environmentId: "local",
    input: {
      threadId: "thread-test",
      visitedAt: DateTime.formatIso(completedAt),
    },
  });
});

it("acknowledges a reopened answer after navigating through an answerless conversation", async () => {
  focused = true;
  const a = thread();
  await act(() => root.render(<Probe value={a} />));
  const b = thread(false);
  await act(() =>
    root.render(
      <Probe
        value={{
          ...b,
          projection: {
            ...b.projection,
            thread: { ...b.projection.thread, id: ThreadId.make("answerless-b") },
          },
        }}
      />,
    ),
  );
  expect(visit).toHaveBeenCalledTimes(1);
  await act(() => root.render(<Probe value={a} />));
  expect(visit).toHaveBeenCalledTimes(2);
});
