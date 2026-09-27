import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  buildThreadReadResult,
  buildThreadTimeline,
  readScientThreadForInvocation,
  renderActivityText,
} from "./handlers.ts";
import { ScientThreadReadToolError } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-thread-read");
const OTHER_PROJECT_ID = ProjectId.make("project-thread-read-other");
const CALLER_ID = ThreadId.make("thread-read-caller");
const SIBLING_ID = ThreadId.make("thread-read-sibling");
const FOREIGN_ID = ThreadId.make("thread-read-foreign");
const TURN_ID = TurnId.make("turn-thread-read-1");

const at = (second: number) => `2026-09-26T10:00:${String(second).padStart(2, "0")}.000Z`;

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  second: number,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: TURN_ID,
  streaming: false,
  createdAt: at(second),
  updatedAt: at(second),
});

const activity = (
  id: string,
  second: number,
  payload: unknown = { tool: "bash" },
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.completed",
  summary: "Ran a command",
  payload,
  turnId: TURN_ID,
  createdAt: at(second),
});

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: CALLER_ID,
    projectId: PROJECT_ID,
    title: "Thread read fixture",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: at(0),
    updatedAt: at(9),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      message("m-user-1", "user", "First question", 1),
      message("m-reasoning-1", "reasoning", "Thinking about it", 2),
      message("m-assistant-1", "assistant", "First answer", 4),
      message("m-system-1", "system", "Context compacted", 6),
      message("m-user-2", "user", "Second question", 7),
    ],
    proposedPlans: [
      {
        id: "plan-1",
        turnId: TURN_ID,
        planMarkdown: "1. Do the thing",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: at(5),
        updatedAt: at(5),
      },
    ],
    activities: [activity("activity-1", 3), activity("activity-2", 4)],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

const makeShell = (thread: OrchestrationThread): OrchestrationThreadShell => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  pullRequests: [],
  latestTurn: thread.latestTurn,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

describe("thread timeline", () => {
  it("interleaves every projected row by creation time with stable positions", () => {
    expect(buildThreadTimeline(makeThread()).map((entry) => entry.itemId)).toEqual([
      "m-user-1",
      "m-reasoning-1",
      "activity-1",
      "m-assistant-1",
      "activity-2",
      "plan-1",
      "m-system-1",
      "m-user-2",
    ]);
  });

  it("returns only the conversation in the default messages view, numbered by the full timeline", () => {
    const result = buildThreadReadResult(makeThread(), { threadId: CALLER_ID });
    expect(result.items.map(({ position, type }) => [position, type])).toEqual([
      [0, "user_message"],
      [3, "assistant_message"],
      [5, "proposed_plan"],
      [7, "user_message"],
    ]);
    expect(result.thread).toMatchObject({
      threadId: CALLER_ID,
      projectId: PROJECT_ID,
      status: "idle",
      itemCount: 8,
      parentThreadId: null,
      relationshipToParent: null,
    });
    expect(result).toMatchObject({ nextPosition: 7, hasMore: false });
  });

  it("returns reasoning, system messages and summarized activity in the activity view", () => {
    const result = buildThreadReadResult(makeThread(), {
      threadId: CALLER_ID,
      view: "activity",
    });
    expect(result.items.map(({ type }) => type)).toEqual([
      "user_message",
      "reasoning",
      "activity",
      "assistant_message",
      "activity",
      "proposed_plan",
      "system_message",
      "user_message",
    ]);
    expect(result.items[2]).toMatchObject({
      itemId: "activity-1",
      title: "Ran a command",
      activityKind: "tool.completed",
      messageId: null,
      turnId: TURN_ID,
      text: 'tool.completed: Ran a command\n{"tool":"bash"}',
    });
  });

  it("pages with an exclusive afterPosition and V2's nextPosition and hasMore", () => {
    const thread = makeThread();
    const first = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      view: "activity",
      limit: 3,
    });
    expect(first.items.map(({ position }) => position)).toEqual([0, 1, 2]);
    expect(first).toMatchObject({ nextPosition: 2, hasMore: true });

    const second = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      view: "activity",
      limit: 3,
      afterPosition: 2,
    });
    expect(second.items.map(({ position }) => position)).toEqual([3, 4, 5]);

    const last = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      view: "activity",
      limit: 3,
      afterPosition: 5,
    });
    expect(last.items.map(({ position }) => position)).toEqual([6, 7]);
    expect(last).toMatchObject({ nextPosition: 7, hasMore: false });

    const past = buildThreadReadResult(thread, { threadId: CALLER_ID, afterPosition: 7 });
    expect(past).toMatchObject({ items: [], nextPosition: null, hasMore: false });
  });

  it("windows long text and continues one item by itemId and textOffset", () => {
    const long = `${"a".repeat(10)}${"b".repeat(10)}${"c".repeat(5)}`;
    const thread = makeThread({
      messages: [message("m-long", "assistant", long, 1)],
      proposedPlans: [],
      activities: [],
    });

    const page = buildThreadReadResult(thread, { threadId: CALLER_ID, maxCharsPerItem: 10 });
    expect(page.items[0]).toMatchObject({
      text: "a".repeat(10),
      textTruncated: true,
      nextTextOffset: 10,
    });

    // textOffset without itemId is ignored, as in V2.
    const ignored = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      maxCharsPerItem: 10,
      textOffset: 10,
    });
    expect(ignored.items[0]?.text).toBe("a".repeat(10));

    const middle = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      itemId: "m-long",
      textOffset: 10,
      maxCharsPerItem: 10,
    });
    expect(middle.items[0]).toMatchObject({
      text: "b".repeat(10),
      textTruncated: true,
      nextTextOffset: 20,
    });

    const end = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      itemId: "m-long",
      textOffset: 20,
      maxCharsPerItem: 10,
    });
    expect(end.items[0]).toMatchObject({
      text: "c".repeat(5),
      textTruncated: false,
      nextTextOffset: null,
    });
  });

  it("counts offsets in UTF-16 code units", () => {
    const thread = makeThread({
      messages: [message("m-emoji", "assistant", "ab😀cd", 1)],
      proposedPlans: [],
      activities: [],
    });
    const first = buildThreadReadResult(thread, { threadId: CALLER_ID, maxCharsPerItem: 4 });
    expect(first.items[0]).toMatchObject({ text: "ab😀", nextTextOffset: 4 });
    const rest = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      itemId: "m-emoji",
      textOffset: 4,
      maxCharsPerItem: 4,
    });
    expect(rest.items[0]).toMatchObject({ text: "cd", nextTextOffset: null });
  });

  it("finds an item by itemId in any view and returns nothing for an unknown id", () => {
    const thread = makeThread();
    const reasoning = buildThreadReadResult(thread, {
      threadId: CALLER_ID,
      itemId: "m-reasoning-1",
      afterPosition: 5,
    });
    expect(reasoning.items).toMatchObject([{ position: 1, type: "reasoning" }]);
    expect(buildThreadReadResult(thread, { threadId: CALLER_ID, itemId: "missing" })).toMatchObject(
      { items: [], nextPosition: null, hasMore: false },
    );
  });

  it("keeps activity payloads available for complete text-window retrieval", () => {
    const text = renderActivityText(activity("activity-big", 1, { output: "x".repeat(6000) }));
    expect(text.startsWith("tool.completed: Ran a command\n")).toBe(true);
    expect(text).toContain("x".repeat(6000));
    expect(renderActivityText(activity("activity-empty", 1, null))).toBe(
      "tool.completed: Ran a command",
    );
  });

  it("maps fork lineage and the latest turn state into V2's thread vocabulary", () => {
    const result = buildThreadReadResult(
      makeThread({
        forkLineage: { originThreadId: SIBLING_ID, baselineAssistantMessageId: null },
        latestTurn: {
          turnId: TURN_ID,
          state: "error",
          requestedAt: at(1),
          startedAt: at(1),
          completedAt: at(2),
          assistantMessageId: null,
        },
      }),
      { threadId: CALLER_ID },
    );
    expect(result.thread).toMatchObject({
      status: "failed",
      parentThreadId: SIBLING_ID,
      relationshipToParent: "fork",
    });
  });
});

const makeInvocation = (
  capabilities: ReadonlySet<AgentInvocationContext.OperationCapability> = new Set(["threads:read"]),
  threadId: ThreadId = CALLER_ID,
): AgentInvocationContext.AgentInvocationScope => ({
  environmentId: EnvironmentId.make("environment-thread-read"),
  threadId,
  providerSessionId: "provider-session-thread-read",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

/** Active threads resolve through shells; archived ones only through detail. */
function makeSnapshots(
  threads: ReadonlyArray<OrchestrationThread>,
  options: { readonly archived?: ReadonlySet<ThreadId> } = {},
) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const getThreadShellById = vi.fn((threadId: ThreadId) => {
    const thread = byId.get(threadId);
    return Effect.succeed(
      thread === undefined || options.archived?.has(threadId) === true
        ? Option.none()
        : Option.some(makeShell(thread)),
    );
  });
  const getThreadDetailById = vi.fn((threadId: ThreadId) =>
    Effect.succeed(Option.fromNullishOr(byId.get(threadId))),
  );
  const service = {
    getThreadHistoryPage: (
      input: Parameters<ProjectionSnapshotQueryShape["getThreadHistoryPage"]>[0],
    ) => {
      const result = buildThreadReadResult(byId.get(input.threadId)!, input);
      return Effect.succeed({
        items: result.items,
        itemCount: result.thread.itemCount,
        hasMore: result.hasMore,
      });
    },
    getThreadShellById,
    getThreadDetailById,
  } as Partial<ProjectionSnapshotQueryShape> as ProjectionSnapshotQueryShape;
  return { service, getThreadShellById, getThreadDetailById };
}

const read = (
  snapshots: ProjectionSnapshotQueryShape,
  input: Parameters<typeof readScientThreadForInvocation>[0],
  invocation = makeInvocation(),
) =>
  readScientThreadForInvocation(input).pipe(
    Effect.provideService(AgentInvocationContext.AgentInvocationContext, invocation),
    Effect.provideService(ProjectionSnapshotQuery, snapshots),
  );

describe("t3_thread_read authorization", () => {
  const caller = makeThread();
  const sibling = makeThread({ id: SIBLING_ID, title: "Sibling" });
  const foreign = makeThread({ id: FOREIGN_ID, projectId: OTHER_PROJECT_ID, title: "Foreign" });

  it.effect("requires threads:read before touching projections", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller]);
      const error = yield* read(
        snapshots.service,
        { threadId: CALLER_ID },
        makeInvocation(new Set(["sources:read"])),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ScientThreadReadToolError);
      expect(error).toMatchObject({ code: "capability_denied" });
      expect(snapshots.getThreadShellById).not.toHaveBeenCalled();
      expect(snapshots.getThreadDetailById).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads the calling thread itself", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller]);
      const result = yield* read(snapshots.service, { threadId: CALLER_ID });
      expect(result.thread.threadId).toBe(CALLER_ID);
      expect(result.items).toHaveLength(4);
    }),
  );

  it.effect("reads another thread in the calling project", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller, sibling]);
      const result = yield* read(snapshots.service, { threadId: SIBLING_ID, view: "activity" });
      expect(result.thread).toMatchObject({ threadId: SIBLING_ID, title: "Sibling" });
      expect(result.items).toHaveLength(8);
    }),
  );

  it.effect("rejects a thread in another project without hydrating its timeline", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller, foreign]);
      const error = yield* read(snapshots.service, { threadId: FOREIGN_ID }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "thread_outside_project" });
      expect(error.message).toContain("calling project");
      expect(snapshots.getThreadDetailById).not.toHaveBeenCalled();
    }),
  );

  it.effect("lets a projectless thread read only itself", () =>
    Effect.gen(function* () {
      const projectless = makeThread({ projectId: null });
      const snapshots = makeSnapshots([
        projectless,
        makeThread({ id: SIBLING_ID, projectId: null }),
      ]);
      expect((yield* read(snapshots.service, { threadId: CALLER_ID })).thread.projectId).toBeNull();
      const error = yield* read(snapshots.service, { threadId: SIBLING_ID }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "thread_outside_project" });
    }),
  );

  it.effect("reports a missing or deleted thread as not found", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller]);
      const error = yield* read(snapshots.service, {
        threadId: ThreadId.make("thread-read-deleted"),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "thread_not_found" });
    }),
  );

  it.effect("resolves archived callers and targets through their detail rows", () =>
    Effect.gen(function* () {
      const snapshots = makeSnapshots([caller, sibling], {
        archived: new Set([CALLER_ID, SIBLING_ID]),
      });
      const result = yield* read(snapshots.service, { threadId: SIBLING_ID });
      expect(result.thread.threadId).toBe(SIBLING_ID);
      expect(snapshots.getThreadDetailById).toHaveBeenCalledWith(CALLER_ID, { activityKinds: [] });
    }),
  );
});

it("retrieves a stored tool payload past the old 4,000-character cap", () => {
  const marker = "important-result-at-end";
  const thread = makeThread({ activities: [activity("long-tool", 3, "x".repeat(6000) + marker)] });
  const result = buildThreadReadResult(thread, {
    threadId: CALLER_ID,
    itemId: "long-tool",
    textOffset: 5000,
    maxCharsPerItem: 2000,
  });
  expect(result.items[0]?.text).toContain(marker);
});
