import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  MessageId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";
import { advanceTestClock } from "../../test/testClock";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
  publishNotification: (_notification: TestNotification) => {},
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);

class TestNotification extends EventTarget {
  static permission = "granted";
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    state.publishNotification(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}
// The mocked modules read `state` and the focus flags, so every test resets them before
// starting the service.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  const testRegistry = AtomRegistry.make();
  const previousShells = state.shells;
  const notifications: TestNotification[] = [];
  const previousPublication = state.publishNotification;
  state.publishNotification = (notification) => {
    notifications.push(notification);
  };
  state.shells = { set: (id, value) => testRegistry.set(shellAtom(id), value) };
  stack.defer(() => {
    state.shells = previousShells;
    notifications.length = 0;
    state.publishNotification = previousPublication;
  });
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.settingsListeners.clear();
  testRegistry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const router = {
    state: { matches: [{ params: {} }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  return {
    notifications,
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

// SCIENT-FORK:START — each notification gate suppresses visual alerts and the badge.
it.for(["off", "sound", "focused", "denied", "archived"])(
  "does not show visual alerts when %s",
  async (condition, { signal }) => {
    using _timers = fakeTimers();
    await using app = setup();
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied") TestNotification.permission = "denied";
    app.start();
    complete();
    if (condition === "archived")
      state.shells.set(
        "one",
        shell({
          archivedAt: "2026-09-13T08:00:00Z",
          hasPendingApprovals: true,
        }),
      );
    await advanceTestClock(signal, WORKING_EXIT_GRACE_MS);
    expect(app.notifications).toHaveLength(0);
    expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
  },
);
// SCIENT-FORK:END

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    using _timers = fakeTimers();
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true }));
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = app.notifications[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

function compactionShell(silent: boolean, status: "running" | "completed" | "failed") {
  const threadId = ThreadId.make("thread");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const runId = RunId.make("compact-run");
  const messageId = MessageId.make("compact-message");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const completedAt = status === "running" ? null : DateTime.makeUnsafe("2026-09-13T07:01:00.000Z");
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Test thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: SHELL_NOW,
      updatedAt: SHELL_NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: SHELL_NOW,
        startedAt: SHELL_NOW,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user",
        createdBy: silent ? "agent" : "user",
        creationSource: silent ? "server" : "web",
        text: "/compact",
        attachments: [],
        streaming: false,
        createdAt: SHELL_NOW,
        updatedAt: SHELL_NOW,
        ...(silent ? { idleCompaction: "beforeCacheExpires" as const } : {}),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: SHELL_NOW,
  } satisfies OrchestrationV2ThreadProjection;
  return {
    status: "live",
    snapshot: Option.some({ threads: [threadShellFromProjection(projection, () => [])] }),
  };
}

it.for([
  ["pre-expiry compaction", true, "completed", []],
  ["manual compaction", false, "completed", ["Thread completed"]],
  ["failed pre-expiry compaction", true, "failed", ["Thread failed"]],
] as const)(
  "notifies for %s only when attention is needed",
  async ([_, silent, status, titles], { signal }) => {
    using _timers = fakeTimers();
    await using app = setup();
    app.setEnvironmentIds(["one"]);
    state.shells.set("one", compactionShell(silent, "running"));
    app.start();
    state.shells.set("one", compactionShell(silent, status));
    await advanceTestClock(signal, WORKING_EXIT_GRACE_MS);
    expect(app.notifications.map((notification) => notification.title)).toEqual(titles);
  },
);

it("holds a completion through a continuation gap and notifies once it settles", async ({
  signal,
}) => {
  using _timers = fakeTimers();
  await using app = setup();
  app.start();
  const finished = (turnId: string, completedAt: string) => ({
    latestTurn: { turnId, state: "completed", completedAt },
  });
  state.shells.set("one", shell(finished("turn-1", "2026-09-13T07:00:01.000Z")));
  state.shells.set(
    "one",
    shell({ latestTurn: { turnId: "turn-2", state: "running", completedAt: null } }),
  );
  state.shells.set("one", shell(finished("turn-2", "2026-09-13T07:00:02.000Z")));
  expect(app.notifications).toEqual([]);
  await advanceTestClock(signal, WORKING_EXIT_GRACE_MS - 1);
  expect(app.notifications).toEqual([]);
  await advanceTestClock(signal, 1);
  expect(app.notifications.map((sent) => sent.title)).toEqual(["Thread completed"]);
});
