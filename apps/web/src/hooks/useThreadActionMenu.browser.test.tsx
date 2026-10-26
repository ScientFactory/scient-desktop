import { render as _fixtureRender, type Screen, act } from "../../test/render";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type ScientCompletedAnswer,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createElement, useEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import { useThreadActionMenu } from "./useThreadActionMenu";
import { threadEnvironment } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";

const boundary = vi.hoisted(() => ({
  serverTracked: true,
  markUnread: vi.fn(),
  unrelatedCommand: vi.fn(),
  show: vi.fn(),
  navigate: vi.fn(),
  shell: {
    id: "thread",
    title: "Completed answer",
    environmentId: "header-env",
    projectId: "project",
    branch: null,
    worktreePath: null,
    pinnedAt: null,
    settledOverride: null,
    autoSettleDisabledAt: null,
    snoozedUntil: null,
    runtime: null,
    latestRun: { status: "completed", completedAt: "2026-10-05T08:20:00.000Z" },
    latestCompletedAnswer: null as ScientCompletedAnswer | null,
  },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: boundary.navigate, state: { matches: [] } }),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (selector: (settings: ClientSettings) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: () => vi.fn(),
  };
});
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../state/entities", () => ({
  useProjects: () => [],
  readThreadShell: () => boundary.shell,
  readEnvironmentSupportsVisitedTracking: () => boundary.serverTracked,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsActiveReorder: () => true,
  readEnvironmentThreadRefs: () => [],
  readProject: () => null,
  readThreadShells: () => [],
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: vi.fn() },
  readEnvironmentScope: () => true,
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "header-env",
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { markUnread: { command: "mark-unread" } },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerKeybindingsAtom: {},
}));
vi.mock("../state/vcs", () => ({ vcsEnvironment: {} }));
vi.mock("../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));
vi.mock("../scient/conversationExport/ConversationExportDialog", () => ({
  requestConversationExport: vi.fn(),
}));
vi.mock("../scient/conversationExport/exportActions", () => ({
  copyConversationMarkdown: vi.fn(),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.markUnread ? boundary.markUnread : boundary.unrelatedCommand,
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: boundary.show, close: vi.fn() } }),
  ensureLocalApi: () => ({ contextMenu: { show: boundary.show, close: vi.fn() } }),
}));
vi.mock("../scient/sections/useThreadSectionMenu", () => ({
  useThreadSectionMenu: () => ({ menuFor: () => [], handleMenuAction: async () => false }),
}));
vi.mock("../scient/conversationExport/menu", async (original) => ({
  ...(await original<typeof import("../scient/conversationExport/menu")>()),
  handleConversationExportMenuAction: () => false,
}));

const target = {
  environmentId: EnvironmentId.make("header-env"),
  threadId: ThreadId.make("thread"),
};
const key = scopedThreadKey(target);

function Header({ onReady }: { onReady: (menu: ReturnType<typeof useThreadActionMenu>) => void }) {
  const actions = useThreadActionMenu({
    threadRef: target,
    projectCwd: "/synthetic",
    onStartRename: vi.fn(),
    onRequestNewSection: vi.fn(),
    canShareWithGuest: false,
  });
  useEffect(() => onReady(actions), [actions, onReady]);
  return null;
}
async function selectMarkUnread(_fixture: _Fixture) {
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(
      createElement(Header, {
        onReady: (actions) => {
          _fixture.menu = actions;
        },
      }),
    );
  });
  await act(async () => {
    _fixture.menu?.openMenu({ x: 1, y: 2 });
  });
  expect(boundary.show).toHaveBeenCalledOnce();
  expect(boundary.show).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: "mark-unread" })]),
    { x: 1, y: 2 },
  );
}

async function _setupFixture0(_fixture: _Fixture) {
  boundary.serverTracked = true;
  boundary.markUnread.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  boundary.unrelatedCommand.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  boundary.show.mockReset().mockResolvedValue("mark-unread");
  boundary.shell.latestCompletedAnswer = {
    turnId: TurnId.make("answer-run"),
    messageId: MessageId.make("answer"),
    completedAt: "2026-10-05T08:18:15.098Z",
  };
  useUiStateStore.setState({ threadLastVisitedAtById: { [key]: "2026-10-05T08:20:00.000Z" } });
  _fixture.menu = undefined;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => {
    await _fixture.root0?.unmount();
  });
  _fixture.root0 = undefined;
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  vi.unstubAllGlobals();
}

describe("header Mark unread through the shared thread action", () => {
  it("uses the canonical completed answer minus one millisecond for older servers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    boundary.serverTracked = false;
    await selectMarkUnread(_fixture);
    expect(boundary.markUnread).not.toHaveBeenCalled();
    expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(
      "2026-10-05T08:18:15.097Z",
    );
  });
  it("does not invent a local unread answer from a completed run when the canonical answer is null", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    boundary.serverTracked = false;
    boundary.shell.latestCompletedAnswer = null;
    await selectMarkUnread(_fixture);
    expect(boundary.markUnread).not.toHaveBeenCalled();
    expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(
      "2026-10-05T08:20:00.000Z",
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    menu: undefined! as ReturnType<typeof useThreadActionMenu> | undefined,

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
