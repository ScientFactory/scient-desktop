import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

function PendingRequestsProbe({
  _fixture,
  environmentId,
  projection,
  loading = false,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
} & { _fixture: _Fixture }) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    activeThread: projection.thread,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
    promptRef,
    composerRef,
  });
  useLayoutEffect(() => {
    _fixture.publishRequests(state);
  });
  return null;
}

it("retains answers, selections and question position after leaving chat, including while the projection reloads", async () => {
  await using _fixture = _createFixture();

  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("remount-environment");
  const projection = questionProjection(threadRef.threadId);
  const probe = (loading = false) => (
    <PendingRequestsProbe
      _fixture={_fixture}
      environmentId={environmentId}
      projection={projection}
      loading={loading}
    />
  );
  await using screen = await render(probe());
  await act(() =>
    _fixture.requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Keep my text"),
  );
  await act(() => _fixture.requests.onAdvanceActivePendingUserInput());
  await act(() =>
    _fixture.requests.onSelectActivePendingUserInputOption("question-1", "Incremental"),
  );
  await act(() => _fixture.requests.onAdvanceActivePendingUserInput());
  const expected = {
    activePendingQuestionIndex: 2,
    activePendingDraftAnswers: {
      "question-0": { customAnswer: "Keep my text" },
      "question-1": { selectedOptionValues: ["Incremental"] },
    },
  };
  expect(_fixture.requests).toMatchObject(expected);

  // New thread and Settings both unmount the chat that owns this hook.
  await screen.rerender(null);
  await screen.rerender(probe());
  expect(_fixture.requests).toMatchObject(expected);

  await screen.rerender(null);
  await screen.rerender(probe(true));
  expect(_fixture.requests.activePendingUserInput).toBeNull();
  await screen.rerender(probe());
  expect(_fixture.requests).toMatchObject(expected);
});

it("isolates drafts by environment, thread and request and discards only resolved requests", async () => {
  await using _fixture = _createFixture();

  using _timers = fakeTimers();
  const environmentId = EnvironmentId.make("scope-environment");
  const projection = questionProjection(threadRef.threadId);
  const scopes = [
    { environmentId, projection },
    { environmentId: EnvironmentId.make("other-environment"), projection },
    { environmentId, projection: questionProjection(ThreadId.make("other-thread")) },
    { environmentId, projection: questionProjection(threadRef.threadId, ["second", "first"]) },
  ];
  await using screen = await render(null);
  const show = (scope: Omit<ComponentProps<typeof PendingRequestsProbe>, "_fixture">) =>
    screen.rerender(<PendingRequestsProbe _fixture={_fixture} {...scope} />);
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(_fixture.requests.activePendingQuestionIndex).toBe(0);
    expect(_fixture.requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBeUndefined();
    await act(() =>
      _fixture.requests.onChangeActivePendingUserInputCustomAnswer("question-0", `Answer ${index}`),
    );
    await act(() => _fixture.requests.onAdvanceActivePendingUserInput());
  }

  await show({
    environmentId,
    projection: {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) =>
        request.id === "first"
          ? { ...request, status: "resolved", resolvedAt: projection.updatedAt }
          : request,
      ),
    },
  });
  expect(_fixture.requests.activePendingUserInput?.requestId).toBe("second");
  for (const [index, scope] of scopes.entries()) {
    await show(scope);
    expect(_fixture.requests.activePendingQuestionIndex).toBe(index === 0 ? 0 : 1);
    expect(_fixture.requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe(
      index === 0 ? undefined : `Answer ${index}`,
    );
  }
});

function _createFixture() {
  let _published_requests = undefined! as ReturnType<typeof usePendingThreadRequests>;

  const stack = new AsyncDisposableStack();
  return {
    get requests() {
      return _published_requests;
    },
    publishRequests(next: typeof _published_requests) {
      _published_requests = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
