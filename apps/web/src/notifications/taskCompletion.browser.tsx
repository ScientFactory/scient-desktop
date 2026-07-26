// FILE: taskCompletion.browser.tsx
// Purpose: Proves mounted notification-surface ownership across real store transitions.
// Layer: Browser runtime regression tests

import "../index.css";

import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { syncServerThreadDetail, useStore } from "../store";
import { useTerminalStateStore, type ThreadTerminalState } from "../terminalStateStore";
import { activityManager, useActivityStore } from "./activityStore";
import { TaskCompletionNotifications } from "./taskCompletion";

const runtime = vi.hoisted(() => ({
  activeThreadId: null as string | null,
  foreground: true,
  settings: {
    enableSystemTaskCompletionNotifications: true,
    enableTaskCompletionToasts: true,
  },
  showSystemNotification: vi.fn(async () => true),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select(runtime.activeThreadId ? { threadId: runtime.activeThreadId } : {}),
}));

vi.mock("../appSettings", () => ({
  useAppSettings: () => ({ settings: runtime.settings }),
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({
    diff: undefined,
    diffFilePath: undefined,
    diffTurnId: undefined,
    panel: undefined,
    splitViewId: undefined,
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-completion-runtime");
const PROJECT_ID = ProjectId.makeUnsafe("project-completion-runtime");
const TURN_ID = TurnId.makeUnsafe("turn-completion-runtime");
const MESSAGE_ID = MessageId.makeUnsafe("message-completion-runtime");
const BASE_ISO = "2026-07-26T12:00:00.000Z";
const LEGACY_COMPLETION_KEY = `thread:${THREAD_ID}:completed:legacy`;

type ReadModelThread = OrchestrationReadModel["threads"][number];

function makeThread(
  input: {
    activities?: ReadModelThread["activities"];
    completedAt?: string | null;
  } = {},
): ReadModelThread {
  const completedAt = input.completedAt ?? null;
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Runtime notification proof",
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    runtimeMode: "full-access",
    envMode: "local",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: TURN_ID,
      state: completedAt ? "completed" : "running",
      requestedAt: BASE_ISO,
      startedAt: BASE_ISO,
      completedAt,
      assistantMessageId: completedAt ? MESSAGE_ID : null,
    },
    createdAt: BASE_ISO,
    updatedAt: completedAt ?? BASE_ISO,
    deletedAt: null,
    handoff: null,
    messages: completedAt
      ? [
          {
            id: MESSAGE_ID,
            role: "assistant",
            text: "The requested work is complete.",
            turnId: TURN_ID,
            streaming: false,
            source: "native",
            createdAt: BASE_ISO,
            updatedAt: completedAt,
          },
        ]
      : [],
    activities: input.activities ?? [],
    proposedPlans: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: completedAt ? "ready" : "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: completedAt ? null : TURN_ID,
      lastError: null,
      updatedAt: completedAt ?? BASE_ISO,
    },
  };
}

function installThread(thread: ReadModelThread): void {
  const next = syncServerThreadDetail(useStore.getState(), thread);
  useStore.setState({ ...next, threadsHydrated: true });
}

function terminalState(input: {
  attention?: Record<string, "attention" | "review">;
  running?: string[];
}): ThreadTerminalState {
  const terminalIds = ["terminal-completion", "terminal-attention"];
  return {
    entryPoint: "chat",
    terminalOpen: false,
    presentationMode: "drawer",
    workspaceLayout: "both",
    workspaceActiveTab: "terminal",
    terminalHeight: 320,
    terminalIds,
    terminalLabelsById: {
      "terminal-attention": "Review terminal",
      "terminal-completion": "Build terminal",
    },
    terminalTitleOverridesById: {},
    terminalCliKindsById: {},
    terminalAttentionStatesById: input.attention ?? {},
    runningTerminalIds: input.running ?? [],
    activeTerminalId: terminalIds[0]!,
    terminalGroups: [],
    activeTerminalGroupId: "test-group",
  };
}

function publishLegacyCompletion(): void {
  activityManager.publish({
    dedupeKey: LEGACY_COMPLETION_KEY,
    source: "thread",
    status: "recent",
    tone: "success",
    title: "Old duplicate completion",
    destination: { type: "thread", threadId: THREAD_ID },
  });
}

function completeThread(): void {
  installThread(makeThread({ completedAt: new Date(Date.now() + 1_000).toISOString() }));
}

let originalDesktopBridge: typeof window.desktopBridge;
let visibilityDescriptor: PropertyDescriptor | undefined;
let hasFocusSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  runtime.activeThreadId = null;
  runtime.foreground = true;
  runtime.settings.enableSystemTaskCompletionNotifications = true;
  runtime.settings.enableTaskCompletionToasts = true;
  runtime.showSystemNotification.mockClear();

  useActivityStore.getState().reset();
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  useStore.setState({
    activityByThreadId: {},
    activityIdsByThreadId: {},
    messageByThreadId: {},
    messageIdsByThreadId: {},
    proposedPlanByThreadId: {},
    proposedPlanIdsByThreadId: {},
    sidebarThreadSummaryById: {},
    threadIds: [],
    threadSessionById: {},
    threadShellById: {},
    threadTurnStateById: {},
    threads: [],
    threadsHydrated: false,
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
  });

  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (runtime.foreground ? "visible" : "hidden"),
  });
  hasFocusSpy = vi.spyOn(document, "hasFocus").mockImplementation(() => runtime.foreground);

  originalDesktopBridge = window.desktopBridge;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      notifications: {
        isSupported: vi.fn(async () => true),
        show: runtime.showSystemNotification,
      },
    },
  });
});

afterEach(() => {
  hasFocusSpy?.mockRestore();
  hasFocusSpy = null;
  if (visibilityDescriptor) {
    Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  }
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: originalDesktopBridge,
  });
  useActivityStore.getState().reset();
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  document.body.innerHTML = "";
});

describe("TaskCompletionNotifications runtime ownership", () => {
  it.each([
    {
      name: "visible foreground thread",
      activeThreadId: THREAD_ID,
      foreground: true,
      systemEnabled: true,
      systemCalls: 0,
    },
    {
      name: "off-screen foreground thread",
      activeThreadId: null,
      foreground: true,
      systemEnabled: true,
      systemCalls: 0,
    },
    {
      name: "background thread with OS alerts disabled",
      activeThreadId: null,
      foreground: false,
      systemEnabled: false,
      systemCalls: 0,
    },
    {
      name: "background thread with OS alerts enabled",
      activeThreadId: null,
      foreground: false,
      systemEnabled: true,
      systemCalls: 1,
    },
  ])(
    "keeps ordinary completion out of Activity for a $name",
    async ({ activeThreadId, foreground, systemEnabled, systemCalls }) => {
      runtime.activeThreadId = activeThreadId;
      runtime.foreground = foreground;
      runtime.settings.enableSystemTaskCompletionNotifications = systemEnabled;
      installThread(makeThread());
      publishLegacyCompletion();

      const screen = await render(<TaskCompletionNotifications />);
      try {
        await vi.waitFor(() => {
          expect(
            useActivityStore
              .getState()
              .items.some((item) => item.dedupeKey === LEGACY_COMPLETION_KEY),
          ).toBe(false);
        });

        completeThread();

        await vi.waitFor(() => {
          expect(runtime.showSystemNotification).toHaveBeenCalledTimes(systemCalls);
          expect(
            useActivityStore
              .getState()
              .items.some(
                (item) => item.source === "thread" && item.dedupeKey.includes(":completed:"),
              ),
          ).toBe(false);
        });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("preserves actionable chat and managed-terminal Activity paths", async () => {
    installThread(makeThread());
    useTerminalStateStore.setState({
      terminalStateByThreadId: {
        [THREAD_ID]: terminalState({ running: ["terminal-completion"] }),
      },
    });
    publishLegacyCompletion();

    const screen = await render(<TaskCompletionNotifications />);
    try {
      await vi.waitFor(() => {
        expect(
          useActivityStore
            .getState()
            .items.some((item) => item.dedupeKey === LEGACY_COMPLETION_KEY),
        ).toBe(false);
      });

      const createdAt = new Date(Date.now() + 1_000).toISOString();
      installThread(
        makeThread({
          activities: [
            {
              id: EventId.makeUnsafe("approval-runtime"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              payload: {
                requestId: "approval-request-runtime",
                requestKind: "command",
              },
              turnId: TURN_ID,
              createdAt,
            },
          ],
        }),
      );
      useTerminalStateStore.setState({
        terminalStateByThreadId: {
          [THREAD_ID]: terminalState({
            attention: {
              "terminal-attention": "attention",
              "terminal-completion": "review",
            },
          }),
        },
      });

      await vi.waitFor(() => {
        expect(
          useActivityStore
            .getState()
            .items.map((item) => item.dedupeKey)
            .toSorted(),
        ).toEqual(
          [
            `terminal:${THREAD_ID}:terminal-attention:attention`,
            `terminal:${THREAD_ID}:terminal-completion:completed`,
            `thread:${THREAD_ID}:attention:approval-request-runtime`,
          ].toSorted(),
        );
      });
    } finally {
      await screen.unmount();
    }
  });
});
