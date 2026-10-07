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
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@t3tools/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
    resumeThreadQueue: Symbol("resumeThreadQueue"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`),
}));

import { QueuedRunsControl, resolveNativeQueuedReorder } from "./QueuedRunsControl";

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
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

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
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

  it("renders an attachment thumbnail on the queued row", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("https://assets.test/attachment-1");
    expect(html).toContain("Queued with a screenshot");
    expect(html).toContain("Edit queued message");
    expect(html).not.toContain("Reorder queued message");
    expect(html).toContain("thread-queue-strip");
    expect(html).not.toContain("Collapse queued messages");
    expect(html).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("keeps the original queued message visible while editing", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={"run:queued" as never}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("Queued with a screenshot");
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
  const html = renderToStaticMarkup(
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
  const html = renderToStaticMarkup(
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
  const html = renderToStaticMarkup(
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

it("renders actual held native workflow reorder and head-only Send before any provider session exists", async () => {
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
  const html = renderToStaticMarkup(
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
  expect(html.match(/>Send<\/button>/g)).toHaveLength(1);
  expect(html).toContain("Resume queue");
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
      renderToStaticMarkup(
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
    expect(after.match(/>Resume queue<\/button>/g) ?? []).toHaveLength(hasTail ? 1 : 0);
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
    return renderToStaticMarkup(
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

  it("offers Send on the idle held head", async () => {
    const html = await heldProjection({});
    expect(html.match(/>Send<\/button>/g)).toHaveLength(1);
    expect(html).toContain(">Resume queue</button>");
  });

  it("offers no Send or Resume queue after the usage limit stopped the thread", async () => {
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
    const html = await heldProjection({
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
    expect(html).toContain("Queue held");
    expect(html.match(/data-testid="thread-queue-row-/g)).toHaveLength(2);
    expect(html).not.toContain(">Send</button>");
    expect(html).not.toContain(">Resume queue</button>");
  });

  it("offers no Send on the first row while a hidden delegated completion goes first", async () => {
    const html = await heldProjection({ automaticCompletion: true });
    expect(html.match(/data-testid="thread-queue-row-/g)).toHaveLength(2);
    expect(html).not.toContain(">Send</button>");
    expect(html).toContain(">Resume queue</button>");
  });
});
