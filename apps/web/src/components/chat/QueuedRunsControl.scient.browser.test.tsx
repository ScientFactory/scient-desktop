import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ComponentProps } from "react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  shell: null as unknown,
  command: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
  useThreadShell: (() => state.shell) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.command) as never,
}));
vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<unknown>) =>
    resources.map(() => null)) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { QUEUE_ADMISSION_STATUS_DELAY_MS } from "../../scient/threadQueue/useScientQueueParts";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";

const base = makeThreadProjectionFixture();

function setup(projection: OrchestrationV2ThreadProjection, shell: unknown = null) {
  state.projection = { projection };
  state.shell = shell;
  state.command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

const props = {
  environmentId: EnvironmentId.make("environment:test"),
  threadId: base.thread.id,
  optimisticMessages: [],
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  timestampFormat: "locale",
  onOpenThread: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

function queuedRun(ordinal: number, held: boolean): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: base.thread.id,
    ordinal,
    providerInstanceId: base.thread.providerInstanceId,
    modelSelection: base.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
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
  };
}

/** A held queue on an idle thread, optionally behind a delegated completion. */
function heldQueue(input: {
  readonly before?: ReadonlyArray<OrchestrationV2Run>;
  readonly automaticCompletion?: boolean;
  readonly turnItems?: OrchestrationV2ThreadProjection["turnItems"];
}): OrchestrationV2ThreadProjection {
  const runs = [
    queuedRun(2, true),
    queuedRun(3, true),
    ...(input.automaticCompletion ? [queuedRun(4, false)] : []),
  ];
  return {
    ...base,
    runs: [...(input.before ?? []), ...runs],
    messages: runs.map((run) => ({
      id: run.userMessageId,
      threadId: base.thread.id,
      runId: run.id,
      nodeId: null,
      role: "user" as const,
      text: `Message ${run.ordinal}`,
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
              parentRunId: RunId.make("parent"),
              generation: 1,
              taskIds: [NodeId.make("task")],
            },
          }),
    })),
    turnItems: input.turnItems ?? [],
  };
}

const errorItem = (runId: RunId, code: string, nodeId: NodeId | null = null) =>
  ({
    id: TurnItemId.make(`error-${runId}`),
    type: "error",
    threadId: base.thread.id,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: "Error",
    startedAt: base.updatedAt,
    completedAt: base.updatedAt,
    updatedAt: base.updatedAt,
    failure: { class: code, message: "Failed.", code, retryable: null },
  }) as OrchestrationV2ThreadProjection["turnItems"][number];

// The client's snapshot of a thread whose last run hit the usage limit. A newer session
// that lifts the limit may be missing from a windowed snapshot.
function limitedQueue() {
  const limited: OrchestrationV2Run = {
    ...queuedRun(1, false),
    id: RunId.make("limited"),
    rootNodeId: NodeId.make("limited-root"),
    status: "failed",
    queueHeld: undefined,
    queuePosition: undefined,
    startedAt: base.updatedAt,
    completedAt: base.updatedAt,
  } as OrchestrationV2Run;
  return heldQueue({
    before: [limited],
    turnItems: [errorItem(limited.id, "usage_limit", limited.rootNodeId)],
  });
}

const sendButtons = (screen: Awaited<ReturnType<typeof render>>) =>
  screen
    .getByRole("button", { name: "Send now", exact: true })
    .elements()
    .filter((button) => button.checkVisibility());

describe("held queue Send follows the server's queue.resume rule", () => {
  // regression: 7327b42210 fix(queue): Send on any queued message resumes the queue
  it("offers Send now on every held row of an idle thread", async () => {
    setup(heldQueue({}));
    await using screen = await render(<QueuedRunsControl {...props} />);
    expect(sendButtons(screen)).toHaveLength(2);
    expect(screen.container.textContent).not.toMatch(/Queue held|Resume queue|Steer/);
  });

  it("keeps Send now on user rows while a hidden delegated completion waits to go first", async () => {
    setup(heldQueue({ automaticCompletion: true }));
    await using screen = await render(<QueuedRunsControl {...props} />);
    expect(screen.getByRole("listitem").elements()).toHaveLength(2);
    expect(sendButtons(screen)).toHaveLength(2);
  });

  it("sends the head from the shortcut once, ignoring key repeats", async () => {
    setup(heldQueue({}));
    const ref = createRef<QueuedRunsControlHandle>();
    await using _screen = await render(<QueuedRunsControl {...props} ref={ref} />);
    expect(ref.current?.steerNext(true)).toBe(true);
    expect(state.command).not.toHaveBeenCalled();
    await act(async () => {
      expect(ref.current?.steerNext(false)).toBe(true);
      expect(ref.current?.steerNext(false)).toBe(true);
    });
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: RunId.make("run-2") },
    });
  });

  // regression: 7ed434c8e1 fix(queue): keep queue controls unless the server's shell confirms the limit
  it("hides Send now, from rows and the shortcut, only when the shell confirms a usage limit", async () => {
    setup(limitedQueue(), { runtime: { lastErrorClass: "usage_limit" } });
    const ref = createRef<QueuedRunsControlHandle>();
    await using screen = await render(<QueuedRunsControl {...props} ref={ref} />);
    expect(screen.getByRole("listitem").elements()).toHaveLength(2);
    expect(sendButtons(screen)).toHaveLength(0);
    expect(ref.current?.steerNext(false)).toBe(false);
    expect(state.command).not.toHaveBeenCalled();

    // A lifted limit (lastErrorClass: null) takes the same path as a missing shell.
    setup(limitedQueue(), null);
    await screen.rerender(<QueuedRunsControl {...props} />);
    expect(sendButtons(screen)).toHaveLength(2);
  });
});

it("shows a failed start with Retry, keeps the row, and retries that message", async () => {
  setup(heldQueue({ turnItems: [errorItem(RunId.make("run-2"), "queued_start_failed")] }));
  await using screen = await render(<QueuedRunsControl {...props} />);
  expect(screen.getByRole("alert").element().textContent).toContain(
    "The queued message could not start.",
  );
  expect(screen.getByRole("listitem").elements()).toHaveLength(2);
  await screen.getByRole("button", { name: "Retry" }).click();
  expect(state.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, runId: RunId.make("run-2") },
  });
});

it("says why a queue command failed", async () => {
  setup(heldQueue({}));
  state.command.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The run already started.")),
  });
  await using screen = await render(<QueuedRunsControl {...props} />);
  await screen.getByRole("button", { name: "Remove queued message", exact: true }).first().click();
  await vi.waitFor(() =>
    expect(screen.getByRole("alert").element().textContent).toContain("The run already started."),
  );
});

it.each([false, true])(
  "keeps one Cancel after extraction removes the edited row (another row remains: %s)",
  async (hasTail) => {
    const queue = heldQueue({});
    const extracted = {
      ...queue,
      runs: queue.runs.flatMap((run) =>
        run.id === RunId.make("run-2")
          ? [{ ...run, status: "cancelled" as const, queueHeld: false, queuePosition: null }]
          : hasTail
            ? [run]
            : [],
      ),
    };
    setup(extracted);
    await using screen = await render(
      <QueuedRunsControl {...props} editingRunId={RunId.make("run-2")} />,
    );
    expect(
      screen.getByRole("button", { name: "Cancel editing queued message" }).elements(),
    ).toHaveLength(1);
    expect(screen.container.textContent).not.toContain("Message 2");
    expect(screen.getByRole("listitem").elements()).toHaveLength(hasTail ? 1 : 0);
  },
);

it("previews a follow-up being admitted, saying Queuing… only when admission is slow", async () => {
  setup({ ...base, runs: [], messages: [] });
  const preview = (accepted: boolean) => [
    {
      id: MessageId.make("follow-up"),
      text: "Follow-up",
      attachments: [],
      queueAdmission: { accepted },
    },
  ];
  using _clock = fakeTimers();
  await using screen = await render(
    <QueuedRunsControl {...props} optimisticMessages={preview(false)} />,
  );
  const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? null;
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  expect(screen.container.textContent).toContain("Follow-up");
  expect(screen.getByRole("button", { name: "Edit queued message" }).element()).toBeDisabled();
  await advance(QUEUE_ADMISSION_STATUS_DELAY_MS - 1);
  expect(status()).toBeNull();
  await advance(1);
  expect(status()).toBe("Queuing…");
  // Acceptance retires the label within its short visible hold.
  await screen.rerender(<QueuedRunsControl {...props} optimisticMessages={preview(true)} />);
  await advance(400);
  expect(status()).toBeNull();
});

it("steers the head into the running turn, and edits the latest message unless an edit is open", async () => {
  const running: OrchestrationV2Run = {
    ...queuedRun(1, false),
    id: RunId.make("active"),
    status: "running",
    queueHeld: undefined,
    queuePosition: undefined,
    activeAttemptId: "attempt" as never,
    startedAt: base.updatedAt,
  } as OrchestrationV2Run;
  const queue = heldQueue({});
  setup({
    ...queue,
    runs: [running, ...queue.runs.map((run) => ({ ...run, queueHeld: false }))],
    providerTurns: [{ runAttemptId: "attempt", status: "running" }] as never,
    providerSessions: [
      {
        providerInstanceId: base.thread.modelSelection.instanceId,
        capabilities: { turns: { supportsActiveSteering: true } },
      },
    ] as never,
  });
  const onEditQueuedRun = vi.fn();
  const ref = createRef<QueuedRunsControlHandle>();
  await using screen = await render(
    <QueuedRunsControl {...props} ref={ref} onEditQueuedRun={onEditQueuedRun} />,
  );
  await act(async () => {
    expect(ref.current?.steerNext(false)).toBe(true);
  });
  expect(state.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, queuedRunId: RunId.make("run-2"), targetRunId: running.id },
  });
  await act(async () => {
    expect(ref.current?.editLatest(false)).toBe(true);
  });
  expect(onEditQueuedRun).toHaveBeenCalledWith(
    expect.objectContaining({ runId: RunId.make("run-3"), text: "Message 3" }),
  );
  await screen.rerender(
    <QueuedRunsControl
      {...props}
      ref={ref}
      onEditQueuedRun={onEditQueuedRun}
      editingRunId={RunId.make("run-3")}
    />,
  );
  expect(ref.current?.editLatest(false)).toBe(false);
});
