import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  QueuedRunsControl,
  type QueuedRunsControlHandle,
} from "../../components/chat/QueuedRunsControl";
import type { ThreadQueueStrip } from "./ThreadQueueStrip";
import { editQueuedMessageShortcut, steerQueuedMessageShortcut } from "./queueShortcuts";

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
  useThreadShell: () => null,
  useThreadProjection: () => ({
    projection: {
      thread: {
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
      },
      runs: ["first", "last"].map((name, index) => ({
        id: `run:${name}`,
        userMessageId: `message:${name}`,
        status: "queued",
        queueHeld: true,
        ordinal: index + 1,
        queuePosition: index + 1,
        modelSelection: { instanceId: "codex", model: "gpt-5" },
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
vi.mock("./ThreadQueueStrip", () => ({
  ThreadQueueStrip: (props: Parameters<typeof ThreadQueueStrip>[0]) => {
    state.strip = props;
    return null;
  },
}));

const environmentId = EnvironmentId.make("queue-environment");
const threadId = ThreadId.make("queue-thread");
const edit = vi.fn();
async function _setupFixture0(_fixture: _Fixture) {
  const container = document.createElement("div");
  _fixture.root0 = _fixture.stack.use(await _fixtureRender(null, { container, router: false }));
  state.promote.mockReset().mockResolvedValue({ _tag: "Success" });
  state.workflow.canPromoteToSteer = true;
  state.workflow.canReorder = true;
  state.workflow.isHeld = false;
  state.strip = null;
  for (const action of [state.reorder, state.cancel, state.resume])
    action.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  edit.mockReset();
  stripSteer.mockReset();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
}
async function render(
  _fixture: _Fixture,
  editingRunId: Parameters<typeof QueuedRunsControl>[0]["editingRunId"] = null,
) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <QueuedRunsControl
          ref={_fixture.queue}
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
const stripSteer = vi.fn();
function steer(
  _fixture: _Fixture,
  repeat = false,
  nativeQueue: QueuedRunsControlHandle | null = _fixture.queue.current,
) {
  return steerQueuedMessageShortcut({
    repeat,
    nativeQueue,
    stripHead: undefined,
    steerStripItem: stripSteer,
  });
}
function editLatest(
  _fixture: _Fixture,
  repeat = false,
  nativeQueue: QueuedRunsControlHandle | null = _fixture.queue.current,
) {
  return editQueuedMessageShortcut({ repeat, nativeQueue });
}

describe("native queued keyboard commands", () => {
  it("steers the native queue head to the actual active run even without legacy items", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => {
      expect(steer(_fixture)).toBe(true);
    });
    expect(state.promote).toHaveBeenCalledOnce();
    expect(state.promote).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, queuedRunId: "run:first", targetRunId: "run:active" },
    });
    // A held key is consumed without promoting again.
    expect(steer(_fixture, true)).toBe(true);
    expect(state.promote).toHaveBeenCalledOnce();
    expect(stripSteer).not.toHaveBeenCalled();
  });
  it("edits the latest native message and leaves caret navigation alone during an edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(editLatest(_fixture, true)).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    await act(() => {
      expect(editLatest(_fixture)).toBe(true);
    });
    expect(edit).toHaveBeenCalledWith({
      runId: "run:last",
      messageId: "message:last",
      text: "Last",
      attachments: [],
    });
    await render(_fixture, RunId.make("run:last"));
    expect(editLatest(_fixture)).toBe(false);
  });
  it("does not consume unavailable queue shortcuts", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.workflow.canPromoteToSteer = false;
    await render(_fixture);
    expect(steer(_fixture)).toBe(false);
    expect(editLatest(_fixture, false, null)).toBe(false);
    expect(steer(_fixture, false, null)).toBe(false);
    expect(state.promote).not.toHaveBeenCalled();
    expect(stripSteer).not.toHaveBeenCalled();
  });
  it("falls back to steering the Scient strip's first message, once per press", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const head = { queueItemId: "queue-item:first" } as never;
    const steerStripItem = vi.fn();
    expect(
      steerQueuedMessageShortcut({
        repeat: false,
        nativeQueue: null,
        stripHead: head,
        steerStripItem,
      }),
    ).toBe(true);
    expect(steerStripItem).toHaveBeenCalledWith(head);
    expect(
      steerQueuedMessageShortcut({
        repeat: true,
        nativeQueue: null,
        stripHead: head,
        steerStripItem,
      }),
    ).toBe(true);
    expect(steerStripItem).toHaveBeenCalledOnce();
  });
});

describe("Scient strip native command adapter", () => {
  it("maps native row actions and per-row Send to existing commands without legacy queue IDs", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
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
    await render(_fixture);
    expect(state.strip).not.toHaveProperty("onResume");
    expect(state.strip?.supportsExplicitSend).toBe(true);
    // Send is offered on the last row too; it resumes the queue from that message.
    expect(state.strip?.canSendItem?.(state.strip.items[1]!)).toBe(true);
    await act(() => state.strip?.onSend(state.strip.items[1]!));
    expect(state.resume).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, runId: "run:last" },
    });
  });
  it("preserves unavailable native reorder capability even if a stale drag callback fires", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.workflow.canReorder = false;
    await render(_fixture);
    await act(() => state.strip?.onReorder(["run:last", "run:first"]));
    expect(state.reorder).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const queue = createRef<QueuedRunsControlHandle>();
  return {
    queue,
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
