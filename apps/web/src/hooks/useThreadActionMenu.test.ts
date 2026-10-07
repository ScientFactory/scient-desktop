import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type ScientCompletedAnswer,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: boundary.navigate, state: { matches: [] } }),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (selector: (settings: ClientSettings) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  readThreadShell: () => boundary.shell,
  readEnvironmentSupportsVisitedTracking: () => boundary.serverTracked,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "header-env" }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.markUnread ? boundary.markUnread : boundary.unrelatedCommand,
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: boundary.show, close: vi.fn() } }),
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
let renderer: ReactTestRenderer | undefined;
let menu: ReturnType<typeof useThreadActionMenu> | undefined;
function Header({ onReady }: { onReady: (menu: ReturnType<typeof useThreadActionMenu>) => void }) {
  const actions = useThreadActionMenu({
    threadRef: target,
    projectCwd: "/synthetic",
    onStartRename: vi.fn(),
    onRequestNewSection: vi.fn(),
  });
  useEffect(() => onReady(actions), [actions, onReady]);
  return null;
}
async function selectMarkUnread() {
  await act(async () => {
    renderer = create(
      createElement(Header, {
        onReady: (actions) => {
          menu = actions;
        },
      }),
    );
  });
  await act(async () => {
    menu?.openMenu({ x: 1, y: 2 });
  });
  expect(boundary.show).toHaveBeenCalledOnce();
  expect(boundary.show).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: "mark-unread" })]),
    { x: 1, y: 2 },
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  menu = undefined;
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  vi.unstubAllGlobals();
});

describe("header Mark unread through the shared thread action", () => {
  it("dispatches the exact scoped native mutation when the server tracks visits", async () => {
    await selectMarkUnread();
    expect(boundary.markUnread).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(
      "2026-10-05T08:20:00.000Z",
    );
    expect(boundary.unrelatedCommand).not.toHaveBeenCalled();
  });
  it("uses the canonical completed answer minus one millisecond for older servers", async () => {
    boundary.serverTracked = false;
    await selectMarkUnread();
    expect(boundary.markUnread).not.toHaveBeenCalled();
    expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(
      "2026-10-05T08:18:15.097Z",
    );
  });
  it("does not invent a local unread answer from a completed run when the canonical answer is null", async () => {
    boundary.serverTracked = false;
    boundary.shell.latestCompletedAnswer = null;
    await selectMarkUnread();
    expect(boundary.markUnread).not.toHaveBeenCalled();
    expect(useUiStateStore.getState().threadLastVisitedAtById[key]).toBe(
      "2026-10-05T08:20:00.000Z",
    );
  });
});
