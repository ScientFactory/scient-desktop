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
import { RELEASED_COMPLETION_GRACE_MS } from "./ThreadNotificationCoordinator.logic";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  closeToast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
  publishNotification: (_notification: TestNotification) => {},
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.closeToast as never,
    },
  };
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
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      pendingSubagentRequestsAtom: (() => noRequestsAtom) as never,
      get delegatedUnderParentAtom() {
        return noDelegatedAtom as never;
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
const noRequestsAtom = Atom.make(new Map());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());

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
  pendingRequestId: "request-1",
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
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
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
  const routeListeners = new Set<() => void>();
  const route = { params: {} as Record<string, string> };
  const router = {
    state: { matches: [route] },
    navigate: state.navigate,
    subscribe: (_event: string, listener: () => void) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
  } as unknown as AnyRouter;
  return {
    notifications,
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    openThread: (environmentId: string, threadId: string) => {
      route.params = { environmentId, threadId };
      for (const listener of routeListeners) listener();
    },
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

// SCIENT-FORK:START — each notification gate suppresses visual alerts and the badge.
it.for(["off", "sound", "focused", "denied", "archived"])(
  "does not show visual alerts when %s",
  async (condition) => {
    await using app = setup();
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied") TestNotification.permission = "denied";
    app.start();
    if (condition === "archived")
      state.shells.set(
        "one",
        shell({
          archivedAt: "2026-09-13T08:00:00Z",
          hasPendingApprovals: true,
          latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T08:00:00Z" },
        }),
      );
    else complete();
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
  async ([_, silent, status, titles]) => {
    await using app = setup();
    app.setEnvironmentIds(["one"]);
    state.shells.set("one", compactionShell(silent, "running"));
    app.start();
    state.shells.set("one", compactionShell(silent, status));
    expect(app.notifications.map((notification) => notification.title)).toEqual(titles);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies once per %s request, not again as queued runs start behind it",
  async (flag) => {
    await using app = setup();
    app.start();
    const waiting = (turnId: string, pendingRequestId: string) =>
      shell({
        [flag]: true,
        pendingRequestId,
        latestTurn: { turnId, state: "running", completedAt: null },
      });
    state.shells.set("one", waiting("turn-1", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-2"));
    const title = flag === "hasPendingApprovals" ? "Approval needed" : "Input needed";
    expect(app.notifications.map(({ title }) => title)).toEqual([title, title]);
  },
);

it("presents completion notifications and sound as soon as the shell completes", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
    }),
  );
  expect(app.notifications.map((sent) => sent.title)).toEqual(["Thread completed"]);
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
});

it.each([false, true])(
  "presents one completion when a monitor ends with a final wake (disconnected: %s)",
  async (disconnect) => {
    await using app = setup();
    using _timers = fakeTimers();
    state.mode = "notifications-and-sound";
    app.start();
    const watching = (
      turnId: string,
      turnState: string,
      completedAt: string | null,
      latestRunBackgroundWake: boolean,
      pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: "monitor" }>,
    ) => ({
      status: "live",
      snapshot: Option.some({
        threads: [
          {
            ...toV2ThreadShell({
              ...thread,
              latestTurn: { turnId, state: turnState, completedAt },
            }),
            latestRunBackgroundWake,
            pendingBackgroundTasks,
          },
        ],
      }),
    });
    const monitor = [{ taskId: "watch", kind: "monitor" as const }];
    const titles = () => app.notifications.map(({ title }) => title);
    state.shells.set(
      "one",
      watching("turn", "completed", "2026-09-13T07:00:01.000Z", false, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    state.shells.set("one", watching("wake", "running", null, true, monitor));
    state.shells.set(
      "one",
      watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    // The adapter drains the roster before the final wake starts.
    state.shells.set("one", watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []));
    expect(titles()).toEqual(["Thread completed"]);
    if (disconnect) {
      state.shells.set("one", {
        ...watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []),
        status: "cached",
      });
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(titles()).toEqual(["Thread completed"]);
    }

    state.shells.set("one", watching("final", "running", null, false, []));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    state.shells.set("one", watching("final", "completed", "2026-09-13T07:00:11.000Z", false, []));
    expect(titles()).toEqual(["Thread completed", "Thread completed"]);
    expect(state.sound).toHaveBeenCalledTimes(2);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies for offline completion and %s once across reconnects",
  async (flag) => {
    await using app = setup();
    const asking = { id: "asking", hasPendingApprovals: true };
    const offline = { id: "offline", [flag]: true };
    const done = {
      id: "done",
      latestTurn: {
        turnId: "done-turn",
        state: "completed",
        completedAt: "2026-09-13T07:00:00.000Z",
      },
    };
    state.shells.set("one", shell({ id: "working" }, { id: "asking" }, { id: "offline" }, done));
    app.start();
    state.shells.set("one", shell({ id: "working" }, asking, { id: "offline" }, done));
    state.shells.set("one", {
      ...shell({ id: "working" }, asking, { id: "offline" }, done),
      status: "cached",
    });

    const completed = {
      id: "working",
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    };
    state.shells.set("one", {
      ...shell(completed, asking, offline, done),
      status: "synchronizing",
    });
    state.shells.set("one", shell(completed, asking, offline, done));

    expect(app.notifications.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
    state.shells.set("one", { ...shell(completed, asking, offline, done), status: "cached" });
    state.shells.set("one", shell(completed, asking, offline, done));
    expect(app.notifications.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
  },
);

it.each([false, true])(
  "does not replay a notified completion after reconnect (continued: %s)",
  async (continued) => {
    await using app = setup();
    app.start();
    const completed = shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    });
    state.shells.set("one", completed);
    state.shells.set("one", { ...completed, status: "cached" });
    expect(app.notifications.map(({ title }) => title)).toEqual(["Thread completed"]);
    state.shells.set("one", continued ? shell() : completed);
    expect(app.notifications.map(({ title }) => title)).toEqual(["Thread completed"]);
  },
);

it("opening a thread or removing its environment closes only its in-app toasts, and disabling notifications closes the rest", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.toast
    .mockReturnValueOnce("one-completed")
    .mockReturnValueOnce("one-approval")
    .mockReturnValueOnce("one-other")
    .mockReturnValueOnce("two-completed");
  state.shells.set("one", shell({}, { id: "other" }));
  app.start();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed, { id: "other" }));
  state.shells.set("one", shell({ ...completed, hasPendingApprovals: true }, { id: "other" }));
  state.shells.set(
    "one",
    shell({ ...completed, hasPendingApprovals: true }, { ...completed, id: "other" }),
  );
  state.shells.set("two", shell(completed));
  expect(state.toast).toHaveBeenCalledTimes(4);

  app.openThread("one", "thread");
  expect(state.closeToast.mock.calls).toEqual([["one-completed"], ["one-approval"]]);

  app.setEnvironmentIds(["one"]);
  expect(state.closeToast.mock.calls.slice(2)).toEqual([["two-completed"]]);

  state.mode = "off";
  state.inApp = false;
  app.changeSettings();
  expect(state.closeToast.mock.calls.slice(3)).toEqual([["one-other"]]);
});
