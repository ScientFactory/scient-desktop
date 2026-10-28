import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import { threadPullRequestsOf } from "@t3tools/client-runtime/thread-pull-requests";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { EMPTY_THREAD_HISTORY_META } from "@t3tools/client-runtime/state/threads";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../test/render";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../test-fixtures";
import * as entities from "../state/entities";
import * as session from "../state/session";
import * as environments from "../state/environments";
import { useComposerDraftStore } from "../composerDraftStore";
import { SidebarProvider } from "./ui/sidebar";
import ChatView from "./ChatView";
import "../index.css";
import * as journal from "../scient/threadQueue/editJournal";

const lab = await vi.hoisted(async () => {
  const { Atom, AtomRegistry, AsyncResult } = await import("effect/reactivity");
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@t3tools/client-runtime/state/threads");
  const state = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE));
  const registry = AtomRegistry.make();
  const listeners = new Set<() => void>();
  const voice = {
    phase: "idle" as "idle" | "recording",
    publish(phase: "idle" | "recording") {
      voice.phase = phase;
      for (const listener of listeners) listener();
    },
  };
  return {
    state,
    registry,
    details: createEnvironmentThreadDetailAtoms(() => state),
    voice,
    listeners,
    command: vi.fn(async (_request: unknown) => AsyncResult.success({ queued: false })),
  };
});

vi.mock("../state/threads", async (original) => ({
  ...(await original()),
  environmentThreadDetails: lab.details,
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: lab.registry,
  subscribeAtomChanges: () => () => undefined,
}));
vi.mock("../state/entities", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../scient/threadQueue/editJournal", { spy: true });
vi.mock("../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => true }));
vi.mock("../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => lab.command,
}));
vi.mock("../scient/voice/voiceClient", () => ({ getVoiceBridge: () => ({}) }));
vi.mock("../scient/voice/useScientVoiceController", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useScientVoiceController: () => ({
      phase: useSyncExternalStore(
        (listener) => {
          lab.listeners.add(listener);
          return () => lab.listeners.delete(listener);
        },
        () => lab.voice.phase,
      ),
      levels: [0.1],
      elapsedMs: 1000,
      errorMessage: null,
      microphonePermissionDenied: false,
      downloadPercent: 0,
      modelSnapshot: null,
      activate: () => lab.voice.publish("recording"),
      cancel: () => lab.voice.publish("idle"),
    }),
  };
});

it("keeps streamed answers live through the real ChatView, composer and voice footer", async () => {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => lab.registry.reset());
  lab.voice.phase = "idle";
  lab.listeners.clear();
  lab.command.mockClear();
  const storage = new Map<string, string>();
  using _storage = stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  using _journals = vi.spyOn(journal, "readQueueEditJournals").mockResolvedValue([]);
  const drafts = useComposerDraftStore.getState();
  cleanup.defer(() => {
    useComposerDraftStore.setState(drafts, true);
  });
  const environmentId = EnvironmentId.make("mounted-chat-view");
  const fixture = makeStreamingTimelineFixture("The first live answer");
  const initial = makeThreadProjectionFixture();
  const projection = {
    ...initial,
    thread: { ...initial.thread, id: fixture.threadId },
    turnItems: fixture.visibleTurnItems.map(({ item }) => item),
    visibleTurnItems: fixture.visibleTurnItems,
  };
  lab.registry.set(
    lab.state,
    AsyncResult.success({
      data: Option.some(projection),
      status: "live",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    }),
  );
  const shell = presentThreadShell(
    environmentId,
    threadShellFromProjection(projection, threadPullRequestsOf),
  );
  using _shell = vi.spyOn(entities, "useQuietThreadShell").mockReturnValue(shell);
  using _permission = vi.spyOn(session, "useEnvironmentScope").mockReturnValue(true);
  using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    version: "1.0.0",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-20T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  using _providers = vi
    .spyOn(environments, "useEnvironmentProviders")
    .mockReturnValue(new Map([[environmentId, [provider]]]));
  using quiet = vi.spyOn(entities, "useQuietThreadProjection");
  const container = document.createElement("div");
  container.style.cssText = "height: 1000px; width: 1000px; display:flex;";
  await using screen = await render(
    <RegistryContext.Provider value={lab.registry}>
      <SidebarProvider className="h-full">
        <ChatView environmentId={environmentId} threadId={fixture.threadId} routeKind="server" />
      </SidebarProvider>
    </RegistryContext.Provider>,
    { container },
  );
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Expand composer", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Dictate a voice message", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Attach files", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Environment disconnected", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Dictate a voice message", exact: true }).click();
  await expect
    .element(screen.getByRole("status").filter({ hasText: "Recording" }))
    .toHaveTextContent("Recording");
  const voice = screen.container.querySelector("[data-scient-voice-surface]");
  expect(voice).toBeInstanceOf(HTMLElement);
  expect(voice?.closest("[data-chat-composer-footer]")).not.toBeNull();
  expect(voice?.closest('[data-chat-composer-actions="right"]')).not.toBeNull();
  expect(voice && getComputedStyle(voice).position).not.toBe("absolute");
  expect(
    voice?.closest("[data-chat-composer-footer]")?.getAttribute("data-scient-voice-busy"),
  ).toBe("true");
  await expect
    .element(screen.getByRole("button", { name: "Attach files", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Environment disconnected", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Cancel recording (Esc)", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Dictate a voice message", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Attach files", exact: true }))
    .toBeVisible();
  const before = quiet.mock.calls.length;
  const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
    row.item.type === "assistant_message" && row.item.streaming
      ? { ...row, item: { ...row.item, text: "The live answer has advanced" } }
      : row,
  );
  await act(() =>
    lab.registry.set(
      lab.state,
      AsyncResult.success({
        data: Option.some({
          ...projection,
          turnItems: visibleTurnItems.map(({ item }) => item),
          visibleTurnItems,
        }),
        status: "live",
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      }),
    ),
  );
  await expect
    .element(screen.getByText("The live answer has advanced", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  expect(quiet.mock.calls.length).toBe(before);
});

it("does not replay a pending question the shell already showed once the thread detail loads", async () => {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => lab.registry.reset());
  const storage = new Map<string, string>();
  using _storage = stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  using _journals = vi.spyOn(journal, "readQueueEditJournals").mockResolvedValue([]);
  const drafts = useComposerDraftStore.getState();
  cleanup.defer(() => {
    useComposerDraftStore.setState(drafts, true);
  });
  const environmentId = EnvironmentId.make("announcer-chat-view");
  const base = makeThreadProjectionFixture();
  const threadId = ThreadId.make("question-thread");
  const runId = RunId.make("question-run");
  const questionProjection = (requestId: RuntimeRequestId) => {
    const nodeId = NodeId.make(`${requestId}-node`);
    return {
      ...base,
      thread: { ...base.thread, id: threadId },
      runs: [
        {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: base.thread.providerInstanceId,
          modelSelection: base.thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("question-message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "waiting" as const,
          requestedAt: base.updatedAt,
          startedAt: base.updatedAt,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      runtimeRequests: [
        {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: base.updatedAt,
          resolvedAt: null,
        },
      ],
      turnItems: [
        {
          id: TurnItemId.make(`${requestId}-item`),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          title: null,
          startedAt: base.updatedAt,
          completedAt: base.updatedAt,
          updatedAt: base.updatedAt,
          type: "user_input_request" as const,
          requestId,
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which module should change first?",
              options: [{ label: "Parser", description: "Start with parsing" }],
              multiSelect: false,
            },
          ],
        },
      ],
    } satisfies OrchestrationV2ThreadProjection;
  };
  const projection = questionProjection(RuntimeRequestId.make("question-request"));
  const shell = presentThreadShell(
    environmentId,
    threadShellFromProjection(projection, threadPullRequestsOf),
  );
  // The uncached thread's shell already shows the question and its run.
  expect(shell).toMatchObject({
    hasPendingUserInput: true,
    latestRun: { runId, status: "waiting" },
  });
  const deliver = (data: Option.Option<OrchestrationV2ThreadProjection>) =>
    lab.registry.set(
      lab.state,
      AsyncResult.success({
        data,
        status: Option.isSome(data) ? "live" : "synchronizing",
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      }),
    );
  deliver(Option.none());
  using _shell = vi.spyOn(entities, "useQuietThreadShell").mockReturnValue(shell);
  using _permission = vi.spyOn(session, "useEnvironmentScope").mockReturnValue(true);
  using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    version: "1.0.0",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-20T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  using _providers = vi
    .spyOn(environments, "useEnvironmentProviders")
    .mockReturnValue(new Map([[environmentId, [provider]]]));
  const container = document.createElement("div");
  container.style.cssText = "height: 1000px; width: 1000px; display:flex;";
  await using screen = await render(
    <RegistryContext.Provider value={lab.registry}>
      <SidebarProvider className="h-full">
        <ChatView environmentId={environmentId} threadId={threadId} routeKind="server" />
      </SidebarProvider>
    </RegistryContext.Provider>,
    { container },
  );
  const region = await vi.waitFor(() => {
    const found = screen.container.querySelector<HTMLElement>('div.sr-only[aria-live="polite"]');
    if (found === null) throw new Error("The activity announcer has not mounted");
    return found;
  });
  await act(() => deliver(Option.some(projection)));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-pending-user-input-toggle]")).not.toBeNull(),
  );
  expect(screen.container.querySelector('div.sr-only[aria-live="polite"]')).toBe(region);
  await expect.element(region).toBeEmptyDOMElement();
  await act(() => deliver(Option.some(questionProjection(RuntimeRequestId.make("next-request")))));
  await expect.element(region).toHaveTextContent("Needs your input");
});
