import "../index.css";

import {
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellStreamEvent,
  type OrchestrationThread,
  type ServerConfig,
  type WsWelcomePayload,
  WS_METHODS,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import {
  createShellSnapshotFromReadModel,
  createTestEnvironmentDescriptor,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  type EffectRpcWebSocketClient,
} from "../test/effectRpcWebSocketMock";
import { getThreadFromState } from "../threadDerivation";
import { useWorkspaceStore } from "../workspaceStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";

const THREAD_ID = ThreadId.makeUnsafe("thread-root-browser-test");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-other-browser-test");
const PROJECT_ID = ProjectId.makeUnsafe("project-root-browser-test");
const NOW_ISO = "2026-03-04T12:00:00.000Z";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

interface EffectRpcStreamHandle {
  client: EffectRpcWebSocketClient;
  requestId: string;
  sentChunkCount: number;
  acknowledgedChunkCount: number;
}

interface ClosableEffectRpcWebSocketClient extends EffectRpcWebSocketClient {
  readonly close: (code?: number, reason?: string) => void;
}

let fixture: TestFixture;
let serverLifecycleStream: EffectRpcStreamHandle | null = null;
let shellStream: EffectRpcStreamHandle | null = null;
const threadStreamByThreadId = new Map<ThreadId, EffectRpcStreamHandle>();
const streamByClientAndRequestId = new WeakMap<
  EffectRpcWebSocketClient,
  Map<string, EffectRpcStreamHandle>
>();
let delayNextThreadSnapshot = false;
let subscribeShellRequestCount = 0;
const subscribeThreadRequestCountById = new Map<ThreadId, number>();
let subscribeThreadRequests: ThreadId[] = [];
let replayEvents: OrchestrationEvent[] = [];
let replayRequestCursors: number[] = [];
let activeWsClient: ClosableEffectRpcWebSocketClient | null = null;
const mountedAppCleanups = new Set<() => Promise<void>>();

const wsLink = ws.link(/ws(s)?:\/\/.*/);

function createEffectRpcStreamHandle(
  client: EffectRpcWebSocketClient,
  requestId: string,
): EffectRpcStreamHandle {
  const handle = {
    client,
    requestId,
    sentChunkCount: 0,
    acknowledgedChunkCount: 0,
  };
  const streamsByRequestId = streamByClientAndRequestId.get(client) ?? new Map();
  streamsByRequestId.set(requestId, handle);
  streamByClientAndRequestId.set(client, streamsByRequestId);
  return handle;
}

function sendEffectRpcStreamChunk(handle: EffectRpcStreamHandle, value: unknown): void {
  handle.sentChunkCount += 1;
  sendEffectRpcChunk(handle.client, handle.requestId, value);
}

async function waitForEffectRpcStreamAck(handle: EffectRpcStreamHandle): Promise<void> {
  await vi.waitFor(
    () => {
      expect(handle.acknowledgedChunkCount).toBe(handle.sentChunkCount);
    },
    { timeout: 4_000, interval: 16 },
  );
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
  };
}

function createSnapshot(overrides?: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Root test thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-1"),
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
        ...overrides,
      },
    ],
    updatedAt: NOW_ISO,
  } satisfies OrchestrationReadModel;
}

function buildFixture(): TestFixture {
  return {
    snapshot: createSnapshot(),
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function getThreadDetailFromFixtureSnapshot(threadId: ThreadId): OrchestrationThread {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}

function findThreadDetailFromFixtureSnapshot(threadId: ThreadId): OrchestrationThread | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

function resolveWsRpc(tag: string, body?: unknown): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.replayEvents) {
    const request = body as { readonly fromSequenceExclusive?: unknown } | null;
    const fromSequenceExclusive =
      typeof request?.fromSequenceExclusive === "number" ? request.fromSequenceExclusive : 0;
    replayRequestCursors.push(fromSequenceExclusive);
    return replayEvents.filter((event) => event.sequence > fromSequenceExclusive);
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.serverGetEnvironment) {
    return createTestEnvironmentDescriptor();
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  // Void RPCs (output: Schema.Void) decode to `null` on the wire. Returning an
  // object for them produces SchemaError(Expected null, got {}), which fails the
  // RPC stream and triggers the reconnect churn that drops thread events — the
  // root cause of the flaky EventRouter event-stream tests. unsubscribeThread
  // and unsubscribeShell are fire-and-forget void calls the app issues on thread
  // switch, teardown, and reconnect (see routes/__root.tsx and wsNativeApi.ts).
  if (
    tag === ORCHESTRATION_WS_METHODS.unsubscribeThread ||
    tag === ORCHESTRATION_WS_METHODS.unsubscribeShell
  ) {
    return null;
  }
  // Remaining unary methods (provider.listModels, git.readWorkingTreeDiff, etc.)
  // return objects whose schemas accept an empty object, so the permissive
  // fallback is fine for them. Only void methods (handled above) and streaming
  // subscriptions (handled in the request dispatcher) must avoid it.
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    activeWsClient = client;
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const parsed = readEffectRpcClientMessage(client, event.data);
      if (parsed.kind === "ack") {
        const handle = streamByClientAndRequestId.get(client)?.get(parsed.requestId);
        if (handle) {
          handle.acknowledgedChunkCount += 1;
        }
        return;
      }
      if (parsed.kind !== "request") {
        return;
      }
      const request = parsed.request;
      const requestBody = flattenEffectRpcRequestPayload(request.tag, request.payload);
      const method = requestBody._tag;
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        subscribeShellRequestCount += 1;
        shellStream = createEffectRpcStreamHandle(client, request.id);
        sendEffectRpcStreamChunk(shellStream, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerLifecycle) {
        serverLifecycleStream = createEffectRpcStreamHandle(client, request.id);
        sendEffectRpcStreamChunk(serverLifecycleStream, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents
      ) {
        // Streaming subscriptions the EventRouter tests don't assert on: leave the
        // stream open with no chunks, matching the handlers above. They must NOT
        // fall through to sendEffectRpcExit — a stream completes with void, so an
        // Exit(Success({})) decodes as SchemaError(Expected null, got {}), which
        // fails the RPC stream and drives the reconnect churn that drops thread
        // events (the root cause of the flaky event-stream tests).
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        subscribeThreadRequestCountById.set(
          threadId,
          (subscribeThreadRequestCountById.get(threadId) ?? 0) + 1,
        );
        subscribeThreadRequests.push(threadId);
        const threadStream = createEffectRpcStreamHandle(client, request.id);
        threadStreamByThreadId.set(threadId, threadStream);
        if (delayNextThreadSnapshot) {
          delayNextThreadSnapshot = false;
          return;
        }
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        sendEffectRpcStreamChunk(threadStream, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        });
        return;
      }
      sendEffectRpcExit(client, request.id, resolveWsRpc(method, requestBody));
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountApp(options?: {
  routeThreadId?: ThreadId;
  waitForThreadId?: ThreadId | null;
}): Promise<{ cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const routeThreadId = options?.routeThreadId ?? THREAD_ID;
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${routeThreadId}`] }));
  const screen = await render(<RouterProvider router={router} />, { container: host });

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await screen.unmount();
      // EventRouter cleanup starts stream unsubscriptions asynchronously. Give
      // those in-flight mock RPC callbacks a turn to settle before the next test
      // replaces the global WebSocket fixture and Zustand state.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
      host.remove();
    })().finally(() => {
      mountedAppCleanups.delete(cleanup);
    });
    return cleanupPromise;
  };
  mountedAppCleanups.add(cleanup);

  try {
    await vi.waitFor(
      () => {
        if (options?.waitForThreadId === null) {
          expect(useStore.getState().threadsHydrated).toBe(true);
          return;
        }
        const expectedThreadId = options?.waitForThreadId ?? THREAD_ID;
        const expectedThread = findThreadDetailFromFixtureSnapshot(expectedThreadId);
        const actualThread = getThreadFromState(useStore.getState(), expectedThreadId);
        const threadStream = threadStreamByThreadId.get(expectedThreadId);
        expect(actualThread).toBeDefined();
        expect(threadStream).toBeDefined();
        expect(threadStream?.acknowledgedChunkCount).toBe(threadStream?.sentChunkCount);
        for (const expectedMessage of expectedThread?.messages ?? []) {
          expect(actualThread?.messages.some((message) => message.id === expectedMessage.id)).toBe(
            true,
          );
        }
      },
      { timeout: 20_000, interval: 16 },
    );
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }

  return { cleanup };
}

async function sendThreadEventPush(event: OrchestrationEvent) {
  const stream = threadStreamByThreadId.get(event.aggregateId as ThreadId);
  if (!stream) {
    throw new Error(`Thread stream is not connected for ${event.aggregateId}`);
  }
  await waitForEffectRpcStreamAck(stream);
  sendEffectRpcStreamChunk(stream, {
    kind: "event",
    event,
  });
}

async function sendThreadSnapshotPush(threadId: ThreadId, snapshotSequence: number) {
  const stream = threadStreamByThreadId.get(threadId);
  if (!stream) {
    throw new Error(`Thread stream is not connected for ${threadId}`);
  }
  await waitForEffectRpcStreamAck(stream);
  sendEffectRpcStreamChunk(stream, {
    kind: "snapshot",
    snapshot: {
      snapshotSequence,
      thread: getThreadDetailFromFixtureSnapshot(threadId),
    },
  });
}

async function sendShellEventPush(event: OrchestrationShellStreamEvent) {
  if (!shellStream) {
    throw new Error("Shell stream is not connected");
  }
  await waitForEffectRpcStreamAck(shellStream);
  sendEffectRpcStreamChunk(shellStream, event);
}

async function sendServerWelcomePush() {
  if (!serverLifecycleStream) {
    throw new Error("Server lifecycle stream is not connected");
  }
  await waitForEffectRpcStreamAck(serverLifecycleStream);
  sendEffectRpcStreamChunk(serverLifecycleStream, {
    type: "welcome",
    payload: fixture.welcome,
  });
}

describe("EventRouter scoped orchestration sync", () => {
  beforeAll(async () => {
    fixture = buildFixture();
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    resetWsNativeApiForTest();
    fixture = buildFixture();
    document.body.innerHTML = "";
    serverLifecycleStream = null;
    shellStream = null;
    activeWsClient = null;
    threadStreamByThreadId.clear();
    delayNextThreadSnapshot = false;
    localStorage.clear();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threads: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useWorkspaceStore.setState({
      homeDir: null,
      workspacePages: [
        {
          id: "workspace-test",
          title: "Workspace 1",
          layoutPresetId: "single",
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });
    subscribeShellRequestCount = 0;
    subscribeThreadRequestCountById.clear();
    subscribeThreadRequests = [];
    replayEvents = [];
    replayRequestCursors = [];
  });

  afterEach(async () => {
    await Promise.allSettled([...mountedAppCleanups].map((cleanup) => cleanup()));
    resetWsNativeApiForTest();
    document.body.replaceChildren();
    serverLifecycleStream = null;
    shellStream = null;
    threadStreamByThreadId.clear();
  });

  it("drops duplicate thread events after the thread snapshot sequence advances", async () => {
    const mounted = await mountApp();

    try {
      const firstAssistantChunk = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-message-2"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(firstAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
          );
          expect(message?.text).toBe("hello");
        },
        { timeout: 8_000, interval: 16 },
      );

      // A delayed lower-sequence snapshot must not overwrite the live event that
      // already advanced this thread's cursor.
      await sendThreadSnapshotPush(THREAD_ID, 1);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      expect(
        getThreadFromState(useStore.getState(), THREAD_ID)?.messages.find(
          (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
        )?.text,
      ).toBe("hello");

      const secondAssistantChunk = {
        ...firstAssistantChunk,
        sequence: 3,
        eventId: EventId.makeUnsafe("event-message-3"),
        occurredAt: "2026-03-04T12:00:06.000Z",
        payload: {
          ...firstAssistantChunk.payload,
          text: "hello world",
          streaming: false,
          updatedAt: "2026-03-04T12:00:06.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(secondAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
          );
          expect(message?.text).toBe("hello world");
          expect(message?.streaming).toBe(false);
        },
        { timeout: 20_000, interval: 16 },
      );

      // Re-send the stale event only after the newer sequence is observable.
      // This directly exercises the cursor guard named by the test and avoids
      // coupling the assertion to two back-to-back mock transport deliveries.
      await sendThreadEventPush(firstAssistantChunk);
      await new Promise((resolve) => window.setTimeout(resolve, 500));

      const threadAfterDuplicate = getThreadFromState(useStore.getState(), THREAD_ID);
      const messagesAfterDuplicate = threadAfterDuplicate?.messages.filter(
        (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-1"),
      );
      expect(messagesAfterDuplicate).toHaveLength(1);
      expect(messagesAfterDuplicate?.[0]?.text).toBe("hello world");
      expect(messagesAfterDuplicate?.[0]?.streaming).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("replays missed thread detail events when a subscribed shell row advances", async () => {
    const mounted = await mountApp();

    try {
      const assistantMessage = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-replay-assistant"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-replayed-assistant"),
          role: "assistant",
          text: "Recovered from replay",
          turnId: TurnId.makeUnsafe("turn-replayed"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
      const sessionReady = {
        sequence: 3,
        eventId: EventId.makeUnsafe("event-replay-session-ready"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:06.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-03-04T12:00:06.000Z",
          },
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.session-set" }>;
      const otherThreadMessage = {
        sequence: 4,
        eventId: EventId.makeUnsafe("event-replay-other-thread"),
        aggregateKind: "thread",
        aggregateId: OTHER_THREAD_ID,
        occurredAt: "2026-03-04T12:00:07.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: OTHER_THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-replayed-other-thread"),
          role: "assistant",
          text: "Wrong thread",
          turnId: TurnId.makeUnsafe("turn-replayed-other-thread"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:07.000Z",
          updatedAt: "2026-03-04T12:00:07.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
      const futureSameThreadMessage = {
        ...assistantMessage,
        sequence: 5,
        eventId: EventId.makeUnsafe("event-replay-future-assistant"),
        occurredAt: "2026-03-04T12:00:08.000Z",
        payload: {
          ...assistantMessage.payload,
          messageId: MessageId.makeUnsafe("msg-replayed-future-assistant"),
          text: "Future event",
          createdAt: "2026-03-04T12:00:08.000Z",
          updatedAt: "2026-03-04T12:00:08.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
      replayEvents = [assistantMessage, sessionReady, otherThreadMessage, futureSameThreadMessage];

      await sendShellEventPush({
        kind: "thread-upserted",
        sequence: 3,
        thread: {
          ...createShellSnapshotFromReadModel(fixture.snapshot).threads[0]!,
          updatedAt: "2026-03-04T12:00:06.000Z",
          session: sessionReady.payload.session,
        },
      });

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          expect(
            thread?.messages.some(
              (message) =>
                message.id === MessageId.makeUnsafe("msg-replayed-assistant") &&
                message.text === "Recovered from replay" &&
                message.streaming === false,
            ),
          ).toBe(true);
          expect(thread?.session?.orchestrationStatus).toBe("ready");
          expect(
            thread?.messages.some(
              (message) => message.id === MessageId.makeUnsafe("msg-replayed-future-assistant"),
            ),
          ).toBe(false);
          expect(thread?.messages.some((message) => message.text === "Wrong thread")).toBe(false);
        },
        { timeout: 4_000, interval: 16 },
      );
      expect(replayRequestCursors).toContain(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("polls a subscribed running thread to recover missed detail events", async () => {
    const runningTurnId = TurnId.makeUnsafe("turn-catchup-running");
    fixture = {
      ...fixture,
      snapshot: createSnapshot({
        latestTurn: {
          turnId: runningTurnId,
          state: "running",
          requestedAt: "2026-03-04T12:00:04.000Z",
          startedAt: "2026-03-04T12:00:04.500Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: runningTurnId,
          lastError: null,
          updatedAt: "2026-03-04T12:00:04.500Z",
        },
        updatedAt: "2026-03-04T12:00:04.500Z",
      }),
    };

    const assistantMessage = {
      sequence: 2,
      eventId: EventId.makeUnsafe("event-catchup-assistant"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: "2026-03-04T12:00:05.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: MessageId.makeUnsafe("msg-catchup-assistant"),
        role: "assistant",
        text: "Recovered by periodic catch-up",
        turnId: runningTurnId,
        source: "native",
        streaming: false,
        createdAt: "2026-03-04T12:00:05.000Z",
        updatedAt: "2026-03-04T12:00:05.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
    const sessionReady = {
      sequence: 3,
      eventId: EventId.makeUnsafe("event-catchup-session-ready"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: "2026-03-04T12:00:06.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-03-04T12:00:06.000Z",
        },
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.session-set" }>;
    replayEvents = [assistantMessage, sessionReady];

    const mounted = await mountApp();

    try {
      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          expect(
            thread?.messages.some(
              (message) =>
                message.id === MessageId.makeUnsafe("msg-catchup-assistant") &&
                message.text === "Recovered by periodic catch-up" &&
                message.streaming === false,
            ),
          ).toBe(true);
          expect(thread?.session?.orchestrationStatus).toBe("ready");
        },
        { timeout: 5_000, interval: 16 },
      );
      expect(replayRequestCursors).toContain(1);
    } finally {
      fixture = buildFixture();
      await mounted.cleanup();
    }
  });

  it("flushes only the first assistant chunk immediately for a message", async () => {
    const mounted = await mountApp();

    try {
      const firstAssistantChunk = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-message-immediate-1"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-immediate"),
          role: "assistant",
          text: "I’ll start",
          turnId: TurnId.makeUnsafe("turn-immediate"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(firstAssistantChunk);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
          );
          expect(message?.text).toBe("I’ll start");
          expect(message?.streaming).toBe(true);
        },
        { timeout: 4_000, interval: 16 },
      );

      const secondAssistantChunk = {
        ...firstAssistantChunk,
        sequence: 3,
        eventId: EventId.makeUnsafe("event-message-immediate-2"),
        occurredAt: "2026-03-04T12:00:05.050Z",
        payload: {
          ...firstAssistantChunk.payload,
          text: " by scanning the repository.",
          updatedAt: "2026-03-04T12:00:05.050Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(secondAssistantChunk);

      await new Promise((resolve) => window.setTimeout(resolve, 20));

      const threadBeforeThrottleFlush = getThreadFromState(useStore.getState(), THREAD_ID);
      const messageBeforeThrottleFlush = threadBeforeThrottleFlush?.messages.find(
        (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
      );
      expect(messageBeforeThrottleFlush?.text).toBe("I’ll start");

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-immediate"),
          );
          expect(message?.text).toBe("I’ll start by scanning the repository.");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("recovers buffered thread events by re-requesting the missing thread snapshot", async () => {
    delayNextThreadSnapshot = true;
    // The first thread subscription intentionally yields no snapshot, so mount
    // without waiting on thread detail. The buffered event pushed below drives
    // the legitimate event-triggered re-request (routes/__root.tsx
    // requestThreadSnapshot), matching the sibling "draft thread becomes real"
    // test. (Previously this relied on reconnect churn from malformed subscription
    // exits to force the re-subscribe; that churn no longer occurs.)
    const mounted = await mountApp({ waitForThreadId: null });

    try {
      // Wait for the initial (snapshot-less) thread subscription before pushing
      // an event onto its stream.
      await vi.waitFor(
        () => {
          expect(subscribeThreadRequestCountById.get(THREAD_ID) ?? 0).toBeGreaterThanOrEqual(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      const bufferedEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-buffered-message"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:07.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-buffered-assistant"),
          role: "assistant",
          text: "buffered reply",
          turnId: TurnId.makeUnsafe("turn-2"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:07.000Z",
          updatedAt: "2026-03-04T12:00:07.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(bufferedEvent);

      await vi.waitFor(
        () => {
          expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBeGreaterThanOrEqual(2);
        },
        { timeout: 8_000, interval: 16 },
      );

      let thread;
      await vi.waitFor(
        () => {
          thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-buffered-assistant"),
          );
          expect(message?.text).toBe("buffered reply");
        },
        { timeout: 8_000, interval: 16 },
      );

      await sendThreadEventPush(bufferedEvent);

      await new Promise((resolve) => window.setTimeout(resolve, 120));

      thread = getThreadFromState(useStore.getState(), THREAD_ID);
      expect(
        thread?.messages.filter(
          (entry) => entry.id === MessageId.makeUnsafe("msg-buffered-assistant"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("requests a thread snapshot again when a subscribed draft thread becomes real", async () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-draft-promoted");
    delayNextThreadSnapshot = true;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {
        [draftThreadId]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          entryPoint: "chat",
          branch: null,
          worktreePath: null,
          envMode: "local",
          isTemporary: false,
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: draftThreadId,
      },
    });

    const mounted = await mountApp({
      routeThreadId: draftThreadId,
      waitForThreadId: null,
    });

    try {
      await vi.waitFor(
        () => {
          expect(
            subscribeThreadRequests.filter((threadId) => threadId === draftThreadId).length,
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 4_000, interval: 16 },
      );

      const baseThread = fixture.snapshot.threads[0]!;
      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: [
          ...fixture.snapshot.threads,
          {
            ...baseThread,
            id: draftThreadId,
            title: "Promoted thread",
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            latestTurn: null,
            updatedAt: "2026-03-04T12:00:08.000Z",
          } satisfies OrchestrationReadModel["threads"][number],
        ],
      };

      await sendThreadEventPush({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-draft-promoted-assistant"),
        aggregateKind: "thread",
        aggregateId: draftThreadId,
        occurredAt: "2026-03-04T12:00:09.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: draftThreadId,
          messageId: MessageId.makeUnsafe("msg-draft-promoted-assistant"),
          role: "assistant",
          text: "draft promotion rendered",
          turnId: TurnId.makeUnsafe("turn-draft-promoted"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:09.000Z",
          updatedAt: "2026-03-04T12:00:09.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>);

      await sendShellEventPush({
        kind: "thread-upserted",
        sequence: 2,
        thread: createShellSnapshotFromReadModel(fixture.snapshot).threads.find(
          (thread) => thread.id === draftThreadId,
        )!,
      });

      await vi.waitFor(
        () => {
          expect(useStore.getState().threads.some((thread) => thread.id === draftThreadId)).toBe(
            true,
          );
          expect(subscribeThreadRequestCountById.get(draftThreadId)).toBeGreaterThanOrEqual(2);
          expect(
            subscribeThreadRequests.filter((threadId) => threadId === draftThreadId).length,
          ).toBeGreaterThanOrEqual(2);
          const thread = getThreadFromState(useStore.getState(), draftThreadId);
          expect(thread?.messages.at(-1)?.text).toBe("draft promotion rendered");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a live assistant intro when a lagging thread snapshot arrives right after it", async () => {
    const mounted = await mountApp();

    try {
      const introEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-assistant-intro"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:07.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("msg-assistant-intro"),
          role: "assistant",
          text: "I'll start by scanning the repository.",
          turnId: TurnId.makeUnsafe("turn-intro"),
          source: "native",
          streaming: true,
          createdAt: "2026-03-04T12:00:07.000Z",
          updatedAt: "2026-03-04T12:00:07.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      await sendThreadEventPush(introEvent);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-intro"),
          );
          expect(message?.text).toBe("I'll start by scanning the repository.");
        },
        { timeout: 4_000, interval: 16 },
      );

      const previousFixture = fixture;
      fixture = {
        ...fixture,
        snapshot: createSnapshot({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-intro"),
            state: "running",
            requestedAt: "2026-03-04T12:00:07.000Z",
            startedAt: "2026-03-04T12:00:07.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          updatedAt: "2026-03-04T12:00:07.500Z",
        }),
      };

      await sendThreadSnapshotPush(THREAD_ID, 3);

      await vi.waitFor(
        () => {
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          const message = thread?.messages.find(
            (entry) => entry.id === MessageId.makeUnsafe("msg-assistant-intro"),
          );
          expect(message?.text).toBe("I'll start by scanning the repository.");
          expect(thread?.latestTurn?.assistantMessageId).toBe(
            MessageId.makeUnsafe("msg-assistant-intro"),
          );
        },
        { timeout: 4_000, interval: 16 },
      );

      fixture = previousFixture;
    } finally {
      fixture = buildFixture();
      await mounted.cleanup();
    }
  });

  it("subscribes once at startup and does not resubscribe shell sync when workspace pages change", async () => {
    const mounted = await mountApp();

    try {
      await vi.waitFor(
        () => {
          expect(subscribeShellRequestCount).toBe(1);
          expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(1);
        },
        { timeout: 4_000, interval: 16 },
      );

      // A replayed welcome and the initial effect setup must not create two
      // overlapping subscription passes. A duplicate pass can clear the
      // EventRouter cursor and pending-event buffers during cold startup.
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      expect(subscribeShellRequestCount).toBe(1);
      expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(1);

      await sendServerWelcomePush();

      await new Promise((resolve) => window.setTimeout(resolve, 120));
      expect(subscribeShellRequestCount).toBe(1);
      expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(1);

      useWorkspaceStore.getState().createWorkspace();

      await new Promise((resolve) => window.setTimeout(resolve, 120));

      expect(subscribeShellRequestCount).toBe(1);
      expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("reconnects once and rebuilds scoped subscriptions from fresh server snapshots", async () => {
    const mounted = await mountApp();

    try {
      await vi.waitFor(
        () => {
          expect(subscribeShellRequestCount).toBe(1);
          expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(1);
          expect(activeWsClient).not.toBeNull();
        },
        { timeout: 4_000, interval: 16 },
      );

      fixture = {
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: fixture.snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, title: "Recovered after reconnect" } : thread,
          ),
        },
      };
      activeWsClient?.close(1012, "test server restart");

      await vi.waitFor(
        () => {
          expect(subscribeShellRequestCount).toBe(2);
          expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(2);
          expect(getThreadFromState(useStore.getState(), THREAD_ID)?.title).toBe(
            "Recovered after reconnect",
          );
        },
        { timeout: 5_000, interval: 16 },
      );
    } finally {
      fixture = buildFixture();
      await mounted.cleanup();
    }
  });

  it("does not let an older reconnect snapshot overwrite already-applied events", async () => {
    const mounted = await mountApp();
    const latestMessageId = MessageId.makeUnsafe("msg-before-reconnect-boundary");

    try {
      await sendShellEventPush({
        kind: "thread-upserted",
        sequence: 3,
        thread: {
          ...createShellSnapshotFromReadModel(fixture.snapshot).threads[0]!,
          title: "Newest local title",
        },
      });
      await sendThreadEventPush({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-before-reconnect-boundary"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: "2026-03-04T12:00:05.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: latestMessageId,
          role: "assistant",
          text: "Already applied before reconnect",
          turnId: TurnId.makeUnsafe("turn-before-reconnect-boundary"),
          source: "native",
          streaming: false,
          createdAt: "2026-03-04T12:00:05.000Z",
          updatedAt: "2026-03-04T12:00:05.000Z",
        },
      });
      await vi.waitFor(() => {
        const thread = getThreadFromState(useStore.getState(), THREAD_ID);
        expect(thread?.title).toBe("Newest local title");
        expect(thread?.messages.some((message) => message.id === latestMessageId)).toBe(true);
      });

      fixture = {
        ...fixture,
        snapshot: {
          ...fixture.snapshot,
          snapshotSequence: 2,
          threads: fixture.snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? { ...thread, title: "Older reconnect title" } : thread,
          ),
        },
      };
      activeWsClient?.close(1012, "test stale reconnect snapshot");

      await vi.waitFor(
        () => {
          expect(subscribeShellRequestCount).toBe(2);
          expect(subscribeThreadRequestCountById.get(THREAD_ID)).toBe(2);
          const thread = getThreadFromState(useStore.getState(), THREAD_ID);
          expect(thread?.title).toBe("Newest local title");
          expect(thread?.messages.some((message) => message.id === latestMessageId)).toBe(true);
        },
        { timeout: 5_000, interval: 16 },
      );
    } finally {
      fixture = buildFixture();
      await mounted.cleanup();
    }
  });
});
