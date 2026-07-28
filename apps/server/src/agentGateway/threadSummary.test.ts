import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  READ_THREAD_DEFAULT_MESSAGE_LIMIT,
  READ_THREAD_MAX_MESSAGE_LIMIT,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
  deriveAgentThreadStatus,
  paginateThreadMessages,
  summarizeThreadDetail,
  summarizeThreadShell,
  summarizeWaitThreadText,
} from "./threadSummary.ts";

type StatusInput = Parameters<typeof deriveAgentThreadStatus>[0];

function makeStatusInput(
  overrides: {
    readonly sessionStatus?: string;
    readonly turnState?: string;
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  } = {},
): StatusInput {
  return {
    session:
      overrides.sessionStatus === undefined
        ? null
        : ({ status: overrides.sessionStatus } as unknown as StatusInput["session"]),
    latestTurn:
      overrides.turnState === undefined
        ? null
        : ({ state: overrides.turnState } as unknown as StatusInput["latestTurn"]),
    ...(overrides.hasPendingApprovals !== undefined
      ? { hasPendingApprovals: overrides.hasPendingApprovals }
      : {}),
    ...(overrides.hasPendingUserInput !== undefined
      ? { hasPendingUserInput: overrides.hasPendingUserInput }
      : {}),
  };
}

interface ThreadShellOverrides {
  readonly id?: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly parentThreadId?: string | null;
  readonly envMode?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly updatedAt?: string;
  readonly sessionStatus?: string;
  readonly turnState?: string;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}

function makeThreadShell(overrides: ThreadShellOverrides = {}): OrchestrationThreadShell {
  return {
    id: overrides.id ?? "thread-1",
    projectId: overrides.projectId ?? "project-1",
    title: overrides.title ?? "Thread One",
    modelSelection: {
      provider: overrides.provider ?? "codex",
      model: overrides.model ?? "gpt-5-codex",
    },
    parentThreadId: overrides.parentThreadId ?? null,
    envMode: overrides.envMode,
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    archivedAt: overrides.archivedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    session: overrides.sessionStatus === undefined ? null : { status: overrides.sessionStatus },
    latestTurn: overrides.turnState === undefined ? null : { state: overrides.turnState },
    hasPendingApprovals: overrides.hasPendingApprovals,
    hasPendingUserInput: overrides.hasPendingUserInput,
  } as unknown as OrchestrationThreadShell;
}

function makeMessage(
  overrides: {
    readonly text?: string;
    readonly role?: string;
    readonly dispatchOrigin?: string;
    readonly dispatchSource?: string;
    readonly createdAt?: string;
  } = {},
): OrchestrationMessage {
  return {
    role: overrides.role ?? "user",
    text: overrides.text ?? "hello",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...(overrides.dispatchOrigin !== undefined ? { dispatchOrigin: overrides.dispatchOrigin } : {}),
    ...(overrides.dispatchSource !== undefined ? { dispatchSource: overrides.dispatchSource } : {}),
  } as unknown as OrchestrationMessage;
}

function makeMessages(count: number): OrchestrationMessage[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage({ text: `message-${index}`, createdAt: `created-${index}` }),
  );
}

interface ThreadDetailOverrides {
  readonly id?: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sessionStatus?: string;
  readonly lastError?: string | null;
  readonly turnState?: string;
  readonly parentThreadId?: string | null;
  readonly envMode?: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}

function makeThread(overrides: ThreadDetailOverrides = {}): OrchestrationThread {
  return {
    id: overrides.id ?? "thread-1",
    projectId: overrides.projectId ?? "project-1",
    title: overrides.title ?? "Thread One",
    modelSelection: {
      provider: overrides.provider ?? "codex",
      model: overrides.model ?? "gpt-5-codex",
    },
    session:
      overrides.sessionStatus === undefined
        ? null
        : { status: overrides.sessionStatus, lastError: overrides.lastError ?? null },
    latestTurn: overrides.turnState === undefined ? null : { state: overrides.turnState },
    parentThreadId: overrides.parentThreadId ?? null,
    envMode: overrides.envMode,
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-02T00:00:00.000Z",
    messages: overrides.messages ?? [],
    hasPendingApprovals: overrides.hasPendingApprovals,
    hasPendingUserInput: overrides.hasPendingUserInput,
  } as unknown as OrchestrationThread;
}

describe("deriveAgentThreadStatus", () => {
  it("prioritizes pending approvals over a running turn", () => {
    const status = deriveAgentThreadStatus(
      makeStatusInput({ turnState: "running", hasPendingApprovals: true }),
    );
    expect(status).toBe("waiting-for-approval");
  });

  it("returns waiting-for-approval even without an active turn", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ hasPendingApprovals: true }))).toBe(
      "waiting-for-approval",
    );
  });

  it("returns waiting-for-user-input when pending user input is set and approvals are not", () => {
    const status = deriveAgentThreadStatus(
      makeStatusInput({ turnState: "running", hasPendingUserInput: true }),
    );
    expect(status).toBe("waiting-for-user-input");
  });

  it("returns working when the latest turn is running", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ turnState: "running" }))).toBe("working");
  });

  it("returns working when the session is running", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ sessionStatus: "running" }))).toBe("working");
  });

  it("returns working when the session is starting", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ sessionStatus: "starting" }))).toBe("working");
  });

  it("returns error when the latest turn errored", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ turnState: "error" }))).toBe("error");
  });

  it("returns error when the session errored", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ sessionStatus: "error" }))).toBe("error");
  });

  it("returns interrupted when the latest turn was interrupted", () => {
    expect(deriveAgentThreadStatus(makeStatusInput({ turnState: "interrupted" }))).toBe(
      "interrupted",
    );
  });

  it("returns idle otherwise", () => {
    expect(deriveAgentThreadStatus(makeStatusInput())).toBe("idle");
  });
});

describe("summarizeThreadShell", () => {
  it("maps thread fields into a list item", () => {
    const thread = makeThreadShell({
      id: "thread-42",
      projectId: "project-9",
      title: "Refactor gateway",
      provider: "claudeAgent",
      model: "claude-opus",
      parentThreadId: "thread-parent",
      envMode: "cloud",
      branch: "feature/x",
      worktreePath: "/worktrees/thread-42",
      archivedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    const item = summarizeThreadShell(thread, "thread-other");

    expect(item).toEqual({
      threadId: "thread-42",
      projectId: "project-9",
      title: "Refactor gateway",
      provider: "claudeAgent",
      model: "claude-opus",
      status: "idle",
      parentThreadId: "thread-parent",
      envMode: "cloud",
      branch: "feature/x",
      worktreePath: "/worktrees/thread-42",
      archived: true,
      isSelf: false,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("marks isSelf true when the thread id matches the caller", () => {
    const thread = makeThreadShell({ id: "thread-1" });
    expect(summarizeThreadShell(thread, "thread-1").isSelf).toBe(true);
  });

  it("marks isSelf false when the thread id differs from the caller", () => {
    const thread = makeThreadShell({ id: "thread-1" });
    expect(summarizeThreadShell(thread, "thread-2").isSelf).toBe(false);
  });

  it("derives archived=true from a non-null archivedAt", () => {
    const thread = makeThreadShell({ archivedAt: "2026-01-01T00:00:00.000Z" });
    expect(summarizeThreadShell(thread, "caller").archived).toBe(true);
  });

  it("derives archived=false from a null archivedAt", () => {
    const thread = makeThreadShell({ archivedAt: null });
    expect(summarizeThreadShell(thread, "caller").archived).toBe(false);
  });

  it("defaults envMode to local when absent", () => {
    const thread = makeThreadShell({});
    expect(summarizeThreadShell(thread, "caller").envMode).toBe("local");
  });
});

describe("paginateThreadMessages", () => {
  it("returns the newest min(N, defaultLimit) messages with stable absolute indexes", () => {
    const messages = makeMessages(30);
    const page = paginateThreadMessages({ messages });

    expect(page.messages).toHaveLength(READ_THREAD_DEFAULT_MESSAGE_LIMIT);
    expect(page.totalMessages).toBe(30);
    expect(page.messages.map((message) => message.index)).toEqual(
      Array.from({ length: 20 }, (_, offset) => offset + 10),
    );
    expect(page.messages[0]?.text).toBe("message-10");
    expect(page.messages.at(-1)?.text).toBe("message-29");
  });

  it("returns all messages with no cursor when N <= limit", () => {
    const messages = makeMessages(5);
    const page = paginateThreadMessages({ messages });

    expect(page.messages).toHaveLength(5);
    expect(page.messages.map((message) => message.index)).toEqual([0, 1, 2, 3, 4]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("provides a nextCursor pointing to older messages when N > limit", () => {
    const messages = makeMessages(30);
    const page = paginateThreadMessages({ messages });

    expect(typeof page.nextCursor).toBe("string");
    expect(page.nextCursor).toBe("10");
  });

  it("pages backwards via the cursor and eventually stops offering one", () => {
    const messages = makeMessages(30);
    const firstPage = paginateThreadMessages({ messages });
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = paginateThreadMessages({ messages, cursor: firstPage.nextCursor });
    expect(secondPage.messages.map((message) => message.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(secondPage.messages[0]?.text).toBe("message-0");
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("truncates long message text and sets truncated:true with a marker", () => {
    const longText = "x".repeat(80);
    const page = paginateThreadMessages({
      messages: [makeMessage({ text: longText })],
      maxMessageChars: 50,
    });

    const [summary] = page.messages;
    expect(summary?.truncated).toBe(true);
    expect(summary?.text).toContain("[... truncated 30 chars]");
    expect(summary?.text.startsWith("x".repeat(50))).toBe(true);
  });

  it("does not truncate text within the limit", () => {
    const page = paginateThreadMessages({ messages: [makeMessage({ text: "short" })] });
    expect(page.messages[0]?.truncated).toBe(false);
    expect(page.messages[0]?.text).toBe("short");
  });

  it("clamps messageLimit below 1 up to 1", () => {
    const page = paginateThreadMessages({ messages: makeMessages(10), messageLimit: 0 });
    expect(page.messages).toHaveLength(1);
  });

  it("clamps messageLimit above 100 down to 100", () => {
    const page = paginateThreadMessages({ messages: makeMessages(150), messageLimit: 1000 });
    expect(page.messages).toHaveLength(READ_THREAD_MAX_MESSAGE_LIMIT);
  });

  it("includes dispatchOrigin only when present on the input message", () => {
    const page = paginateThreadMessages({
      messages: [makeMessage({ dispatchOrigin: "agent-gateway" }), makeMessage()],
    });

    expect(page.messages[0]?.dispatchOrigin).toBe("agent-gateway");
    expect("dispatchOrigin" in (page.messages[1] as object)).toBe(false);
  });

  it("includes additive dispatchSource only when present on the input message", () => {
    const page = paginateThreadMessages({
      messages: [makeMessage({ dispatchSource: "agent" }), makeMessage()],
    });

    expect(page.messages[0]?.dispatchSource).toBe("agent");
    expect("dispatchSource" in (page.messages[1] as object)).toBe(false);
  });
});

describe("summarizeWaitThreadText", () => {
  it("returns a null summary for null input", () => {
    expect(summarizeWaitThreadText(null)).toEqual({ summary: null, truncated: false });
  });

  it("returns a null summary for undefined input", () => {
    expect(summarizeWaitThreadText(undefined)).toEqual({ summary: null, truncated: false });
  });

  it("passes short text through untruncated", () => {
    expect(summarizeWaitThreadText("hello")).toEqual({ summary: "hello", truncated: false });
  });

  it("truncates text longer than the cap and marks truncated", () => {
    const text = "y".repeat(WAIT_THREAD_SUMMARY_MAX_CHARS + 1000);
    const result = summarizeWaitThreadText(text);

    expect(result.truncated).toBe(true);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.length).toBeLessThanOrEqual(WAIT_THREAD_SUMMARY_MAX_CHARS + 40);
    expect(result.summary).toContain("truncated");
  });
});

describe("summarizeThreadDetail", () => {
  it("maps thread fields and paginates messages", () => {
    const messages = makeMessages(3);
    const thread = makeThread({
      id: "thread-7",
      projectId: "project-3",
      title: "Investigate flake",
      provider: "codex",
      model: "gpt-5-codex",
      sessionStatus: "ready",
      lastError: "boom",
      turnState: "completed",
      parentThreadId: "thread-parent",
      envMode: "cloud",
      branch: "main",
      worktreePath: "/worktrees/thread-7",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
      messages,
    });

    const detail = summarizeThreadDetail({ thread, callerThreadId: "thread-other" });

    expect(detail.threadId).toBe("thread-7");
    expect(detail.projectId).toBe("project-3");
    expect(detail.title).toBe("Investigate flake");
    expect(detail.provider).toBe("codex");
    expect(detail.model).toBe("gpt-5-codex");
    expect(detail.status).toBe("idle");
    expect(detail.sessionStatus).toBe("ready");
    expect(detail.lastError).toBe("Turn failed.");
    expect(JSON.stringify(detail)).not.toContain("boom");
    expect(detail.latestTurnState).toBe("completed");
    expect(detail.parentThreadId).toBe("thread-parent");
    expect(detail.envMode).toBe("cloud");
    expect(detail.branch).toBe("main");
    expect(detail.worktreePath).toBe("/worktrees/thread-7");
    expect(detail.archived).toBe(false);
    expect(detail.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(detail.updatedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(detail.totalMessages).toBe(3);
    expect(detail.messages).toHaveLength(3);
    expect(detail.nextCursor).toBeUndefined();
  });

  it("includes a nextCursor when there are more messages than the page limit", () => {
    const thread = makeThread({ messages: makeMessages(30) });
    const detail = summarizeThreadDetail({ thread, callerThreadId: "caller" });

    expect(detail.nextCursor).toBe("10");
    expect(detail.messages).toHaveLength(20);
  });

  it("defaults sessionStatus/lastError/latestTurnState to null when absent", () => {
    const thread = makeThread({});
    const detail = summarizeThreadDetail({ thread, callerThreadId: "caller" });

    expect(detail.sessionStatus).toBeNull();
    expect(detail.lastError).toBeNull();
    expect(detail.latestTurnState).toBeNull();
  });
});
