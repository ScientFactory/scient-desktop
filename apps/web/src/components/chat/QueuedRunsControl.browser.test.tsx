import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  shell: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deriveThreadQueueWorkflowState: ((projection) =>
      state.workflow ??
      actual.deriveThreadQueueWorkflowState(
        projection,
      )) as typeof actual.deriveThreadQueueWorkflowState,
  };
});

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
  useThreadShell: (() => state.shell) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { QueuedRunsControl, resolveNativeQueuedReorder } from "./QueuedRunsControl";

const roots: Root[] = [];
beforeEach(() => {
  state.projection = null;
  state.workflow = null;
  state.shell = null;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function render(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<QueuedRunsControl {...baseProps} {...props} />));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", async () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render();

    expect(view.childElementCount).toBe(0);
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render();

    expect(view.querySelector("img")?.getAttribute("src")).toBe("https://assets.test/attachment-1");
    expect(view.textContent).toContain("Queued with a screenshot");
    expect(labels(view)).toContain("Edit queued message");
    expect(labels(view).some((label) => label?.startsWith("Reorder queued message"))).toBe(false);
    expect(view.querySelector('[data-testid="thread-queue-strip"]')).not.toBeNull();
    expect(labels(view)).not.toContain("Collapse queued messages");
    expect(labels(view)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render({
      optimisticMessages: [
        {
          id: "message:acknowledged" as never,
          inputIntent: "queued_turn",
          text: "hello",
          attachments: [],
        },
      ],
    });

    expect(view.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render({ editingRunId: "run:queued" as never });

    expect(view.textContent).toContain("Queued with a screenshot");
  });
});

describe("Scient native queue order adapter", () => {
  it("maps head-to-tail and tail-to-head drags to one exact native move", () => {
    const prior = ["a", "b", "c"] as never;
    expect(resolveNativeQueuedReorder(prior, ["b", "c", "a"] as never)).toEqual({
      runId: "a",
      beforeRunId: null,
    });
    expect(resolveNativeQueuedReorder(prior, ["c", "a", "b"] as never)).toEqual({
      runId: "c",
      beforeRunId: "a",
    });
    expect(resolveNativeQueuedReorder(prior, prior)).toBeNull();
    expect(resolveNativeQueuedReorder(prior, ["a", "c", "foreign"] as never)).toBeNull();
  });
});

it("retains ordinary admission previews until receipt/projection while exposing no speculative actions", () => {
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    queuedRuns: [],
    activeRun: { id: "busy" },
    canPromoteToSteer: true,
    canReorder: true,
  };
  const html = renderMarkup(
    <QueuedRunsControl
      environmentId={"env" as never}
      threadId={"thread" as never}
      editingRunId={null}
      onEditQueuedRun={() => undefined}
      onCancelEdit={() => undefined}
      optimisticMessages={[
        {
          id: "awaiting" as never,
          text: "Pending admission",
          attachments: [],
          queueAdmission: { accepted: false },
        },
        {
          id: "accepted" as never,
          text: "Accepted queue admission",
          attachments: [],
          queueAdmission: { accepted: true },
        },
      ]}
    />,
  );
  expect(html).toContain("Pending admission");
  expect(html).toContain("Accepted queue admission");
  expect(html).not.toContain("Queuing…");
  expect(html).not.toContain("Queued<");
  expect(html).not.toContain('aria-label="Edit queued message"');
});

it("reserves the grip on both rows while a pending follow-up is about to become the second", () => {
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    queuedRuns: [
      { run: { id: "queued-one", userMessageId: "queued-message" }, text: "One", attachments: [] },
    ],
    activeRun: { id: "busy" },
    canPromoteToSteer: true,
    canReorder: false,
  };
  const html = renderMarkup(
    <QueuedRunsControl
      environmentId={"env" as never}
      threadId={"thread" as never}
      editingRunId={null}
      onEditQueuedRun={() => undefined}
      onCancelEdit={() => undefined}
      optimisticMessages={[
        {
          id: "follow-up" as never,
          text: "Follow-up",
          attachments: [],
          queueAdmission: { accepted: true },
        },
      ]}
    />,
  );
  expect(html).not.toContain('aria-label="Reorder queued message"');
  expect(html.match(/<span aria-hidden="true" class="invisible shrink-0">/g)).toHaveLength(2);
});

it("shows a held failed-start recovery notice and Retry without dropping the native row", () => {
  state.projection = {
    projection: {
      thread: { providerInstanceId: "codex" },
      runs: [
        {
          id: "held-failed",
          userMessageId: "held-message",
          status: "queued",
          queueHeld: true,
          ordinal: 1,
          queuePosition: 1,
        },
      ],
      providerSessions: [],
      messages: [],
      turnItems: [
        { type: "error", runId: "held-failed", failure: { code: "queued_start_failed" } },
      ],
    },
  };
  state.workflow = {
    queuedRuns: [
      {
        run: { id: "held-failed", userMessageId: "held-message" },
        text: "Retained queued message",
        attachments: [],
      },
    ],
    activeRun: null,
    canPromoteToSteer: false,
    canReorder: true,
    isHeld: true,
  };
  const html = renderMarkup(
    <QueuedRunsControl
      environmentId={"env" as never}
      threadId={"thread" as never}
      editingRunId={null}
      onEditQueuedRun={() => undefined}
      onCancelEdit={() => undefined}
      optimisticMessages={[]}
    />,
  );
  expect(html).toContain("Retained queued message");
  expect(html).toContain("The queued message could not start.");
  expect(html).toContain(">Retry</button>");
  expect(html).toContain(">Send</button>");
});

it("renders actual held native workflow reorder and Send on every row before any provider session exists", async () => {
  const { deriveThreadQueueWorkflowState } = await vi.importActual<
    typeof import("@t3tools/client-runtime/state/thread-workflows")
  >("@t3tools/client-runtime/state/thread-workflows");
  const base = makeThreadProjectionFixture();
  const projection = {
    ...base,
    runs: [1, 2].map((ordinal) => ({
      id: RunId.make(`held-${ordinal}`),
      threadId: base.thread.id,
      ordinal,
      providerInstanceId: base.thread.providerInstanceId,
      modelSelection: base.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`held-message-${ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued" as const,
      queueHeld: true,
      queuePosition: ordinal,
      requestedAt: base.updatedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    })),
    messages: [1, 2].map((ordinal) => ({
      id: MessageId.make(`held-message-${ordinal}`),
      threadId: base.thread.id,
      runId: RunId.make(`held-${ordinal}`),
      nodeId: null,
      role: "user" as const,
      text: `Recovered ${ordinal}`,
      attachments: [],
      streaming: false,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: base.updatedAt,
      updatedAt: base.updatedAt,
    })),
  };
  state.projection = { projection };
  state.workflow = deriveThreadQueueWorkflowState(projection);
  const html = renderMarkup(
    <QueuedRunsControl
      environmentId={EnvironmentId.make("recovered")}
      threadId={base.thread.id}
      optimisticMessages={[]}
      editingRunId={null}
      onEditQueuedRun={() => undefined}
      onCancelEdit={() => undefined}
    />,
  );
  expect(html.match(/aria-label="Reorder queued message"/g)).toHaveLength(2);
  expect(html.match(/>Send<\/button>/g)).toHaveLength(2);
  expect(html).not.toContain("Resume queue");
  expect(html).not.toContain(">Steer<");
});

it.each([false, true])(
  "retains one Cancel after actual extraction removes the native row (tail = %s)",
  async (hasTail) => {
    const { deriveThreadQueueWorkflowState } = await vi.importActual<
      typeof import("@t3tools/client-runtime/state/thread-workflows")
    >("@t3tools/client-runtime/state/thread-workflows");
    const base = makeThreadProjectionFixture();
    const ordinals = hasTail ? [1, 2] : [1];
    const queued = {
      ...base,
      runs: ordinals.map((ordinal) => ({
        id: RunId.make(`extract-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`extract-message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        queueHeld: true,
        queuePosition: ordinal,
        requestedAt: base.updatedAt,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: ordinals.map((ordinal) => ({
        id: MessageId.make(`extract-message-${ordinal}`),
        threadId: base.thread.id,
        runId: RunId.make(`extract-${ordinal}`),
        nodeId: null,
        role: "user" as const,
        text: `Retained payload ${ordinal}`,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: base.updatedAt,
        updatedAt: base.updatedAt,
      })),
    };
    const editingRunId = RunId.make("extract-1");
    const renderControl = () =>
      renderMarkup(
        <QueuedRunsControl
          environmentId={EnvironmentId.make("extraction")}
          threadId={base.thread.id}
          optimisticMessages={[]}
          editingRunId={editingRunId}
          onEditQueuedRun={() => undefined}
          onCancelEdit={() => undefined}
        />,
      );
    state.projection = { projection: queued };
    state.workflow = deriveThreadQueueWorkflowState(queued);
    const before = renderControl();
    expect(before.match(/aria-label="Cancel editing queued message"/g)).toHaveLength(1);
    expect(before).toContain("thread-queue-row-extract-1");
    const extracted = {
      ...queued,
      runs: queued.runs.map((run) =>
        run.id === editingRunId
          ? {
              ...run,
              status: "cancelled" as const,
              queueHeld: false,
              queuePosition: null,
              completedAt: base.updatedAt,
            }
          : run,
      ),
    };
    const retainedMessages = JSON.stringify(extracted.messages);
    state.projection = { projection: extracted };
    const actualWorkflow = deriveThreadQueueWorkflowState(extracted);
    state.workflow = actualWorkflow;
    expect(actualWorkflow.queuedRuns.map(({ run }) => run.id)).toEqual(
      hasTail ? [RunId.make("extract-2")] : [],
    );
    const after = renderControl();
    expect(after.match(/aria-label="Cancel editing queued message"/g)).toHaveLength(1);
    expect(after).not.toContain("thread-queue-row-extract-1");
    expect(after).not.toContain("Retained payload 1");
    expect(after.match(/data-testid="thread-queue-row-/g) ?? []).toHaveLength(hasTail ? 1 : 0);
    expect(after.match(/>Send<\/button>/g) ?? []).toHaveLength(hasTail ? 1 : 0);
    expect(after).not.toContain("Resume queue");
    expect(JSON.stringify(extracted.messages)).toBe(retainedMessages);
    expect(extracted.runs[0]?.status).toBe("cancelled");
    expect(extracted.runs[0]?.queuePosition).toBeNull();
  },
);

describe("held queue Send follows the server's queue.resume rule", () => {
  const heldProjection = async (input: {
    readonly before?: ReadonlyArray<OrchestrationV2Run>;
    readonly automaticCompletion?: boolean;
    readonly turnItems?: OrchestrationV2ThreadProjection["turnItems"];
  }) => {
    const { deriveThreadQueueWorkflowState } = await vi.importActual<
      typeof import("@t3tools/client-runtime/state/thread-workflows")
    >("@t3tools/client-runtime/state/thread-workflows");
    const base = makeThreadProjectionFixture();
    const queuedRun = (ordinal: number, held: boolean): OrchestrationV2Run => ({
      id: RunId.make(`rule-${ordinal}`),
      threadId: base.thread.id,
      ordinal,
      providerInstanceId: base.thread.providerInstanceId,
      modelSelection: base.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`rule-message-${ordinal}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      queueHeld: held,
      queuePosition: ordinal,
      requestedAt: base.updatedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    const queuedRuns = [
      queuedRun(2, true),
      queuedRun(3, true),
      ...(input.automaticCompletion ? [queuedRun(4, false)] : []),
    ];
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      runs: [...(input.before ?? []), ...queuedRuns],
      messages: queuedRuns.map((run) => ({
        id: run.userMessageId,
        threadId: base.thread.id,
        runId: run.id,
        nodeId: null,
        role: "user" as const,
        text: `Rule ${run.ordinal}`,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: base.updatedAt,
        updatedAt: base.updatedAt,
        ...(run.queueHeld
          ? {}
          : {
              delegatedCompletion: {
                parentRunId: RunId.make("rule-parent"),
                generation: 1,
                taskIds: [NodeId.make("rule-task")],
              },
            }),
      })),
      turnItems: input.turnItems ?? [],
    };
    state.projection = { projection };
    state.workflow = deriveThreadQueueWorkflowState(projection);
    return renderMarkup(
      <QueuedRunsControl
        environmentId={EnvironmentId.make("rule")}
        threadId={base.thread.id}
        optimisticMessages={[]}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );
  };

  it("offers Send on every held row of an idle thread, with no held header", async () => {
    const html = await heldProjection({});
    expect(html.match(/>Send<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("Queue held");
    expect(html).not.toContain("Resume queue");
  });

  // The client's snapshot of a thread whose last root run hit the usage limit.
  // A newer session error that lifts the limit may be missing from a windowed
  // snapshot, so only the server-computed shell can confirm the limit.
  const limitedSnapshot = () => {
    const base = makeThreadProjectionFixture();
    const limited: OrchestrationV2Run = {
      id: RunId.make("rule-limited"),
      threadId: base.thread.id,
      ordinal: 1,
      providerInstanceId: base.thread.providerInstanceId,
      modelSelection: base.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("rule-limited-message"),
      rootNodeId: NodeId.make("rule-limited-root"),
      activeAttemptId: null,
      status: "failed",
      requestedAt: base.updatedAt,
      startedAt: base.updatedAt,
      completedAt: base.updatedAt,
      checkpointId: null,
      contextHandoffId: null,
    };
    return heldProjection({
      before: [limited],
      turnItems: [
        {
          id: TurnItemId.make("rule-limit-error"),
          type: "error",
          threadId: base.thread.id,
          runId: limited.id,
          nodeId: limited.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Usage limit",
          startedAt: base.updatedAt,
          completedAt: base.updatedAt,
          updatedAt: base.updatedAt,
          failure: {
            class: "usage_limit",
            message: "Usage limit reached.",
            code: "usage_limit",
            retryable: null,
          },
        },
      ],
    });
  };

  it("offers no Send when the server's shell confirms the usage limit", async () => {
    state.shell = { runtime: { lastErrorClass: "usage_limit" } };
    const html = await limitedSnapshot();
    expect(html.match(/data-testid="thread-queue-row-/g)).toHaveLength(2);
    expect(html).not.toContain(">Send</button>");
  });

  it.each([
    ["a newer session error lifted it", { runtime: { lastErrorClass: null } }],
    ["no shell has arrived", null],
  ])("keeps Send on a limited-looking snapshot when %s", async (_case, shell) => {
    state.shell = shell;
    const html = await limitedSnapshot();
    expect(html.match(/>Send<\/button>/g)).toHaveLength(2);
  });

  it("keeps Send on user rows while a hidden delegated completion waits to go first", async () => {
    const html = await heldProjection({ automaticCompletion: true });
    expect(html.match(/data-testid="thread-queue-row-/g)).toHaveLength(2);
    expect(html.match(/>Send<\/button>/g)).toHaveLength(2);
  });
});

function renderMarkup(node: ReactNode): string {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container.innerHTML;
}
