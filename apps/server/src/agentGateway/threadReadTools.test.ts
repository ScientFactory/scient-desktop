/**
 * Behavioral tests for the agent gateway read/coordination tools.
 *
 * Drives each `synara_*` read tool handler directly against a fake
 * ProjectionSnapshotQuery, asserting project-scope enforcement (the central
 * read policy), pagination/summarization shaping, and the poll-based
 * `synara_wait_for_threads` terminal/timeout/cross-project paths.
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadReadTools } from "./threadReadTools.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import type { ToolContext } from "./toolRuntime.ts";

const CALLER_THREAD = "thread-caller";
const CALLER_PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const ISO = "2026-01-01T00:00:00.000Z";

type Capability = "thread:read" | "thread:write" | "automation:write";

interface Fakes {
  readonly projects?: ReadonlyArray<Record<string, unknown>>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly threadShells?: Record<string, OrchestrationThreadShell>;
  readonly threadDetails?: Record<string, OrchestrationThread>;
}

function projectShell(id: string): Record<string, unknown> {
  return { id, title: `Project ${id}`, workspaceRoot: `/ws/${id}`, isPinned: false };
}

function shell(id: string, overrides?: Record<string, unknown>): OrchestrationThreadShell {
  return {
    id,
    projectId: CALLER_PROJECT,
    title: `Thread ${id}`,
    modelSelection: { provider: "claudeAgent", model: "test-model" },
    parentThreadId: null,
    envMode: "local",
    branch: null,
    worktreePath: null,
    archivedAt: null,
    updatedAt: ISO,
    latestTurn: null,
    session: null,
    ...overrides,
  } as unknown as OrchestrationThreadShell;
}

function message(overrides?: Record<string, unknown>): OrchestrationMessage {
  return {
    id: "msg-1",
    role: "assistant",
    text: "hello",
    turnId: null,
    streaming: false,
    source: "native",
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  } as unknown as OrchestrationMessage;
}

function detail(
  id: string,
  projectId: string,
  overrides?: Record<string, unknown>,
): OrchestrationThread {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    modelSelection: { provider: "claudeAgent", model: "test-model" },
    session: null,
    latestTurn: null,
    parentThreadId: null,
    envMode: "local",
    branch: null,
    worktreePath: null,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    messages: [],
    ...overrides,
  } as unknown as OrchestrationThread;
}

function makeSnapshotQuery(fakes: Fakes): ProjectionSnapshotQueryShape {
  return {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: fakes.projects ?? [],
        threads: fakes.threads ?? [],
        updatedAt: ISO,
      }),
    getThreadShellById: (id: string) => Effect.succeed(Option.fromNullishOr(fakes.threadShells?.[id])),
    getThreadDetailById: (id: string) =>
      Effect.succeed(Option.fromNullishOr(fakes.threadDetails?.[id])),
  } as unknown as ProjectionSnapshotQueryShape;
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    callerThreadId: CALLER_THREAD,
    callerProjectId: CALLER_PROJECT,
    callerSessionKey: "gateway-session:test",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set<Capability>(["thread:read"]),
    callerTurnId: null,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
    ...overrides,
  };
}

function callTool(
  fakes: Fakes,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = makeContext(),
): Promise<McpToolCallResult> {
  const snapshotQuery = makeSnapshotQuery(fakes);
  const requireThreadShell = (id: string) => {
    const found = fakes.threadShells?.[id];
    return found
      ? Effect.succeed(found)
      : Effect.fail(new Error(`Thread "${id}" was not found.`));
  };
  const tools = makeThreadReadTools({ snapshotQuery, requireThreadShell });
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  // Handlers are always invoked behind the transport's defect net (a thrown
  // ToolInputError becomes a defect, not an Effect failure). Mirror that net so
  // these unit calls exercise the same contract the transport enforces.
  return Effect.runPromise(
    tool.handler(args, context).pipe(
      Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
    ),
  );
}

function rawText(result: McpToolCallResult): string {
  return result.content[0]!.text;
}

function jsonBody(result: McpToolCallResult): Record<string, unknown> {
  return JSON.parse(rawText(result)) as Record<string, unknown>;
}

describe("synara_context", () => {
  it("reports harness identity, caller scope, and capability flags", async () => {
    const fakes: Fakes = {
      threadShells: {
        [CALLER_THREAD]: shell(CALLER_THREAD, {
          latestTurn: { turnId: "turn-1", state: "running" },
        }),
      },
    };
    const body = jsonBody(await callTool(fakes, "synara_context", {})) as {
      harness: { name: string };
      caller: { threadId: string; turnId: string | null; projectId: string; provider: string };
      capabilities: Record<string, boolean>;
    };
    expect(body.harness.name).toBe("Synara");
    expect(body.caller.threadId).toBe(CALLER_THREAD);
    expect(body.caller.turnId).toBe("turn-1");
    expect(body.caller.projectId).toBe(CALLER_PROJECT);
    expect(body.caller.provider).toBe("claudeAgent");
    expect(body.capabilities.threadRead).toBe(true);
    expect(body.capabilities.threadWait).toBe(true);
    // Read-only session: no write/automation capability even with a live turn.
    expect(body.capabilities.threadCreate).toBe(false);
    expect(body.capabilities.automations).toBe(false);
  });
});

describe("synara_list_projects", () => {
  it("returns only the caller's own project", async () => {
    const fakes: Fakes = { projects: [projectShell(CALLER_PROJECT), projectShell(OTHER_PROJECT)] };
    const body = jsonBody(await callTool(fakes, "synara_list_projects", {})) as {
      projects: Array<{ projectId: string }>;
    };
    expect(body.projects.map((project) => project.projectId)).toEqual([CALLER_PROJECT]);
  });
});

describe("synara_list_threads", () => {
  const fakes: Fakes = {
    threads: [
      shell("t-a", { updatedAt: "2026-01-03T00:00:00.000Z" }),
      shell("t-b", { parentThreadId: CALLER_THREAD, updatedAt: "2026-01-02T00:00:00.000Z" }),
      shell("t-archived", { archivedAt: ISO, updatedAt: "2026-01-04T00:00:00.000Z" }),
      shell("t-other", { projectId: OTHER_PROJECT, updatedAt: "2026-01-05T00:00:00.000Z" }),
      shell(CALLER_THREAD, { updatedAt: "2026-01-01T00:00:00.000Z" }),
    ],
  };

  it("lists only same-project, non-archived threads sorted newest-first", async () => {
    const body = jsonBody(await callTool(fakes, "synara_list_threads", {})) as {
      threads: Array<{ threadId: string; isSelf: boolean }>;
      totalMatching: number;
    };
    expect(body.threads.map((thread) => thread.threadId)).toEqual(["t-a", "t-b", CALLER_THREAD]);
    expect(body.totalMatching).toBe(3);
    expect(body.threads.find((thread) => thread.threadId === CALLER_THREAD)?.isSelf).toBe(true);
  });

  it("filters by parentThreadId", async () => {
    const body = jsonBody(
      await callTool(fakes, "synara_list_threads", { parentThreadId: CALLER_THREAD }),
    ) as { threads: Array<{ threadId: string }> };
    expect(body.threads.map((thread) => thread.threadId)).toEqual(["t-b"]);
  });

  it("includes archived threads only when asked", async () => {
    const body = jsonBody(
      await callTool(fakes, "synara_list_threads", { includeArchived: true }),
    ) as { threads: Array<{ threadId: string }> };
    expect(body.threads.map((thread) => thread.threadId)).toContain("t-archived");
  });

  it("clamps to the requested limit but reports the full match count", async () => {
    const body = jsonBody(await callTool(fakes, "synara_list_threads", { limit: 1 })) as {
      threads: unknown[];
      totalMatching: number;
    };
    expect(body.threads).toHaveLength(1);
    expect(body.totalMatching).toBe(3);
  });
});

describe("synara_read_thread", () => {
  it("reads a same-project thread's detail and messages", async () => {
    const fakes: Fakes = {
      threadDetails: {
        "t-a": detail("t-a", CALLER_PROJECT, {
          messages: [message({ id: "m1", text: "first" }), message({ id: "m2", text: "second" })],
        }),
      },
    };
    const body = jsonBody(await callTool(fakes, "synara_read_thread", { threadId: "t-a" })) as {
      threadId: string;
      messages: unknown[];
      totalMessages: number;
    };
    expect(body.threadId).toBe("t-a");
    expect(body.messages).toHaveLength(2);
    expect(body.totalMessages).toBe(2);
  });

  it("returns a not-found error for an unknown thread", async () => {
    const result = await callTool({}, "synara_read_thread", { threadId: "t-missing" });
    expect(result.isError).toBe(true);
    expect(rawText(result)).toContain("was not found");
  });

  it("denies a cross-project read with thread_not_found (no project disclosure)", async () => {
    const otherFakes: Fakes = {
      threadDetails: { "t-other": detail("t-other", OTHER_PROJECT) },
    };
    const result = await callTool(otherFakes, "synara_read_thread", { threadId: "t-other" });
    expect(result.isError).toBe(true);
    const body = jsonBody(result) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("thread_not_found");
    expect(body.error.message).not.toContain(OTHER_PROJECT);
  });
});

describe("synara_wait_for_threads", () => {
  it("returns immediately when the pinned turn is already terminal", async () => {
    // The initial pin reads getThreadShellById; the poll loop reads the whole
    // shell snapshot — both must see the thread.
    const completed = shell("t-a", { latestTurn: { turnId: "turn-a", state: "completed" } });
    const waitFakes: Fakes = {
      threads: [completed],
      threadShells: { "t-a": completed },
      threadDetails: {
        "t-a": detail("t-a", CALLER_PROJECT, {
          messages: [message({ role: "assistant", turnId: "turn-a", text: "the answer" })],
        }),
      },
    };
    const body = jsonBody(
      await callTool(waitFakes, "synara_wait_for_threads", { threadIds: ["t-a"] }),
    ) as {
      allTerminal: boolean;
      timedOut: boolean;
      threads: Array<{ state: string; terminal: boolean; summary: string | null }>;
    };
    expect(body.allTerminal).toBe(true);
    expect(body.timedOut).toBe(false);
    expect(body.threads[0]!.state).toBe("completed");
    expect(body.threads[0]!.terminal).toBe(true);
    expect(body.threads[0]!.summary).toBe("the answer");
  });

  it("reports a timeout when a pinned turn stays running", async () => {
    const running = shell("t-a", { latestTurn: { turnId: "turn-a", state: "running" } });
    const waitFakes: Fakes = {
      threads: [running],
      threadShells: { "t-a": running },
    };
    const body = jsonBody(
      await callTool(waitFakes, "synara_wait_for_threads", { threadIds: ["t-a"], timeoutMs: 0 }),
    ) as {
      allTerminal: boolean;
      timedOut: boolean;
      threads: Array<{ state: string; terminal: boolean; timedOut: boolean }>;
    };
    expect(body.allTerminal).toBe(false);
    expect(body.timedOut).toBe(true);
    expect(body.threads[0]!.state).toBe("running");
    expect(body.threads[0]!.terminal).toBe(false);
    expect(body.threads[0]!.timedOut).toBe(true);
  });

  it("denies waiting on a cross-project thread", async () => {
    const waitFakes: Fakes = {
      threadShells: {
        "t-other": shell("t-other", {
          projectId: OTHER_PROJECT,
          latestTurn: { turnId: "turn-o", state: "running" },
        }),
      },
    };
    const result = await callTool(waitFakes, "synara_wait_for_threads", { threadIds: ["t-other"] });
    expect(result.isError).toBe(true);
    const body = jsonBody(result) as { error: { code: string } };
    expect(body.error.code).toBe("thread_not_found");
  });

  it("rejects a runIds array whose length does not match threadIds", async () => {
    const waitFakes: Fakes = {
      threadShells: {
        "t-a": shell("t-a", { latestTurn: { turnId: "turn-a", state: "running" } }),
      },
    };
    const result = await callTool(waitFakes, "synara_wait_for_threads", {
      threadIds: ["t-a"],
      runIds: ["turn-a", "turn-b"],
    });
    expect(result.isError).toBe(true);
    expect(rawText(result)).toContain("same length");
  });
});
