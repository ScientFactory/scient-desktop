import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

import {
  createForkConversationCommand,
  createForkMessageCommands,
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
      requestFork: (next) => {
        target = next;
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
      requestFork: (next) => {
        target = next;
      },
    });
    fork();
    expect(target).toMatchObject({ kind: "running-turn", runId: "running" });
    fork({ preserveComposerDraft: true });
    expect(target).toMatchObject({
      kind: "assistant-response",
      messageId: "completed",
      composerDraft: true,
    });
  });
});

describe("run fork commands share the Scient fork owner", () => {
  it("uses a live completed response and fences a stale source thread", async () => {
    let target: ForkCommandTarget | null = null;
    let live: ReadonlyArray<TimelineEntry> = [];
    const actions = createForkMessageCommands({
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      activeRunningTurnId: null,
      readTimelineEntries: () => live,
      requestFork: (next) => {
        target = next;
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
      latest: false,
      workspaceMode: "local",
    });
  });

  it("forks the running turn without a completed response", async () => {
    let target: ForkCommandTarget | null = null;
    const actions = createForkMessageCommands({
      activeThreadId: ThreadId.make("thread"),
      activeThreadEnvironmentId: EnvironmentId.make("environment"),
      activeRunningTurnId: RunId.make("run"),
      readTimelineEntries: () => [],
      requestFork: (next) => {
        target = next;
      },
    });
    await actions.onForkFromRun({
      sourceThreadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
    });
    expect(target).toMatchObject({ kind: "running-turn", runId: "run" });
  });
});
