import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";
import type { ThreadQueueStrip } from "../../scient/threadQueue/ThreadQueueStrip";
import { handleQueuedRunShortcut } from "./queuedRunShortcuts";

const state = vi.hoisted(() => ({
  workflow: {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    isHeld: false,
    queuedRuns: [
      { run: { id: "run:first", userMessageId: "message:first" }, text: "First", attachments: [] },
      { run: { id: "run:last", userMessageId: "message:last" }, text: "Last", attachments: [] },
    ],
  },
  promote: vi.fn(),
  reorder: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  strip: null as Parameters<typeof ThreadQueueStrip>[0] | null,
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({
    projection: {
      thread: { providerInstanceId: "codex" },
      runs: ["first", "last"].map((name, index) => ({
        id: `run:${name}`,
        userMessageId: `message:${name}`,
        status: "queued",
        queueHeld: true,
        ordinal: index + 1,
        queuePosition: index + 1,
      })),
      providerSessions: [],
      messages: [],
      turnItems: [],
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    promoteQueuedRun: "promote",
    reorderQueuedRun: "reorder",
    cancelQueuedRun: "cancel",
    resumeThreadQueue: "resume",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    ({
      promote: state.promote,
      reorder: state.reorder,
      cancel: state.cancel,
      resume: state.resume,
    })[command],
}));
vi.mock("../../assets/assetUrls", () => ({ useAssetUrls: () => [] }));
// No host nodes are needed to exercise the actual component's imperative
// queue controls and native command transport.
vi.mock("../../scient/threadQueue/ThreadQueueStrip", () => ({
  ThreadQueueStrip: (props: Parameters<typeof ThreadQueueStrip>[0]) => {
    state.strip = props;
    return null;
  },
}));

let root: Root;
const queue = createRef<QueuedRunsControlHandle>();
const environmentId = EnvironmentId.make("queue-environment");
const threadId = ThreadId.make("queue-thread");
const edit = vi.fn();
beforeEach(() => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  state.promote.mockReset().mockResolvedValue({ _tag: "Success" });
  state.workflow.canPromoteToSteer = true;
  state.workflow.canReorder = true;
  state.workflow.isHeld = false;
  state.strip = null;
  for (const action of [state.reorder, state.cancel, state.resume])
    action.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  edit.mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
async function render(
  editingRunId: Parameters<typeof QueuedRunsControl>[0]["editingRunId"] = null,
) {
  await act(() =>
    root.render(
      <QueuedRunsControl
        ref={queue}
        environmentId={environmentId}
        threadId={threadId}
        optimisticMessages={[]}
        editingRunId={editingRunId}
        onEditQueuedRun={edit}
        onCancelEdit={() => undefined}
      />,
    ),
  );
}
function key(repeat = false) {
  return { repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("native queued keyboard commands", () => {
  it("steers the native queue head to the actual active run even without legacy items", async () => {
    await render();
    const event = key();
    await act(() => {
      expect(handleQueuedRunShortcut("thread.steerQueuedMessage", event, queue.current)).toBe(true);
    });
    expect(state.promote).toHaveBeenCalledOnce();
    expect(state.promote).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, queuedRunId: "run:first", targetRunId: "run:active" },
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    const repeated = key(true);
    expect(handleQueuedRunShortcut("thread.steerQueuedMessage", repeated, queue.current)).toBe(
      true,
    );
    expect(state.promote).toHaveBeenCalledOnce();
  });
  it("edits the latest native message and leaves caret navigation alone during an edit", async () => {
    await render();
    expect(handleQueuedRunShortcut("thread.editQueuedMessage", key(true), queue.current)).toBe(
      true,
    );
    expect(edit).not.toHaveBeenCalled();
    await act(() => {
      expect(handleQueuedRunShortcut("thread.editQueuedMessage", key(), queue.current)).toBe(true);
    });
    expect(edit).toHaveBeenCalledWith({
      runId: "run:last",
      messageId: "message:last",
      text: "Last",
      attachments: [],
    });
    await render(RunId.make("run:last"));
    const event = key();
    expect(handleQueuedRunShortcut("thread.editQueuedMessage", event, queue.current)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("does not consume unavailable queue shortcuts", async () => {
    state.workflow.canPromoteToSteer = false;
    await render();
    const event = key();
    expect(handleQueuedRunShortcut("thread.steerQueuedMessage", event, queue.current)).toBe(false);
    expect(handleQueuedRunShortcut("thread.editQueuedMessage", event, null)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(state.promote).not.toHaveBeenCalled();
  });
});

describe("Scient strip native command adapter", () => {
  it("maps native row actions and held resume to existing commands without legacy queue IDs", async () => {
    await render();
    const strip = state.strip;
    expect(strip).not.toBeNull();
    if (!strip) throw new Error("Expected actual native strip props");
    expect(strip.items.map((item) => item.queueItemId)).toEqual(["run:first", "run:last"]);
    const last = strip.items[1];
    if (!last) throw new Error("Expected last native queue row");
    await act(() => strip.onEdit(last));
    expect(edit).toHaveBeenCalledWith({
      runId: "run:last",
      messageId: "message:last",
      text: "Last",
      attachments: [],
    });
    await act(() => strip.onReorder(["run:last", "run:first"]));
    expect(state.reorder).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, runId: "run:first", beforeRunId: null },
    });
    await act(() => strip.onDelete(last));
    expect(state.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, runId: "run:last" },
    });
    await act(() => strip.onSteer(last));
    expect(state.promote).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, queuedRunId: "run:last", targetRunId: "run:active" },
    });
    state.workflow.isHeld = true;
    await render();
    expect(state.strip?.held).toBe(true);
    await act(() => state.strip?.onResume?.());
    expect(state.resume).toHaveBeenCalledWith({ environmentId, input: { threadId } });
    expect(state.strip?.supportsExplicitSend).toBe(true);
    await act(() => state.strip?.onSend(state.strip.items[0]!));
    expect(state.resume).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, runId: "run:first" },
    });
  });
  it("preserves unavailable native reorder capability even if a stale drag callback fires", async () => {
    state.workflow.canReorder = false;
    await render();
    await act(() => state.strip?.onReorder(["run:last", "run:first"]));
    expect(state.reorder).not.toHaveBeenCalled();
  });
});
