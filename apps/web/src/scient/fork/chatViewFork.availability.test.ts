import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

import {
  createForkConversationCommand,
  createForkMessageCommands,
  forkWorktreeAvailabilityFromOptions,
  type ForkCommandTarget,
} from "./chatViewFork";

function answer(id: string, streaming = false): TimelineEntry {
  const createdAt = "2026-10-20T00:00:00Z";
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: `Answer ${id}`,
      runId: RunId.make(id),
      streaming,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

describe("fork command live timeline ownership", () => {
  it("reads the completed answer at invocation, not at shell render time", () => {
    let live: ReadonlyArray<TimelineEntry> = [answer("old")];
    let target: ForkCommandTarget | null = null;
    const fork = createForkConversationCommand({
      timelineEntries: [],
      readTimelineEntries: () => live,
      activeLatestRun: null,
      activeRunningTurnId: null,
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      setForkCommandTarget: (next) => {
        target = typeof next === "function" ? next(target) : next;
      },
    });
    fork();
    expect(target).toMatchObject({ kind: "assistant-response", messageId: "old" });
    live = [answer("old"), answer("new")];
    fork();
    expect(target).toMatchObject({ kind: "assistant-response", messageId: "new" });
  });

  it("keeps a running-turn fork separate from new-chat's last completed answer", () => {
    let target: ForkCommandTarget | null = null;
    const fork = createForkConversationCommand({
      timelineEntries: [],
      readTimelineEntries: () => [answer("completed"), answer("running", true)],
      activeLatestRun: null,
      activeRunningTurnId: RunId.make("running"),
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      setForkCommandTarget: (next) => {
        target = typeof next === "function" ? next(target) : next;
      },
    });
    fork();
    expect(target).toMatchObject({ kind: "running-turn", runId: "running" });
    fork({ preserveComposerDraft: true });
    expect(target).toMatchObject({
      kind: "assistant-response",
      messageId: "completed",
      source: "new-chat",
    });
  });
});

describe("run fork commands share the Scient dialog owner", () => {
  it("uses a live completed response and fences a stale source thread", async () => {
    let target: ForkCommandTarget | null = null;
    let live: ReadonlyArray<TimelineEntry> = [];
    const actions = createForkMessageCommands({
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      activeRunningTurnId: null,
      readTimelineEntries: () => live,
      setForkCommandTarget: (next) => {
        target = typeof next === "function" ? next(target) : next;
      },
    });
    live = [answer("run")];
    await actions.onForkFromRun({
      sourceThreadId: ThreadId.make("other"),
      runId: RunId.make("run"),
    });
    expect(target).toBeNull();
    await actions.onForkFromRun({
      sourceThreadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
    });
    expect(target).toMatchObject({
      kind: "assistant-response",
      messageId: "run",
      source: "this-response",
    });
  });

  it("opens the running-turn dialog without a completed response", async () => {
    let target: ForkCommandTarget | null = null;
    const actions = createForkMessageCommands({
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      activeRunningTurnId: RunId.make("run"),
      readTimelineEntries: () => [],
      setForkCommandTarget: (next) => {
        target = typeof next === "function" ? next(target) : next;
      },
    });
    await actions.onForkFromRun({
      sourceThreadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
    });
    expect(target).toMatchObject({ kind: "running-turn", runId: "run", source: "running-turn" });
  });
});

describe("forkWorktreeAvailabilityFromOptions", () => {
  it("offers a new worktree whenever the server can build one", () => {
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: true }, true)).toEqual({
      available: true,
    });
  });

  it("names a missing checkpoint for a finished fork point", () => {
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: false }, false)).toEqual({
      available: false,
      reason: "no-checkpoint",
    });
  });

  it("names the removed worktree, not Git, for a running fork whose worktree is gone", () => {
    const notice = "The original worktree was removed, so this fork works in the project folder.";
    expect(
      forkWorktreeAvailabilityFromOptions({ newWorktree: false, workspaceNotice: notice }, true),
    ).toEqual({ available: false, reason: "worktree-removed" });
    expect(forkWorktreeAvailabilityFromOptions({ newWorktree: false }, true)).toEqual({
      available: false,
      reason: "no-git-repository",
    });
  });
});
