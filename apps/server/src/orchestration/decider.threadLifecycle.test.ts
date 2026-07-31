import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-31T06:00:00.000Z";
const PARENT = ThreadId.makeUnsafe("thread-parent");
const CHILD = ThreadId.makeUnsafe("subagent:thread-parent:child");
const GRANDCHILD = ThreadId.makeUnsafe("subagent:child:grandchild");
const DELETED_CHILD = ThreadId.makeUnsafe("subagent:thread-parent:deleted");
const UNRELATED = ThreadId.makeUnsafe("thread-unrelated");

function makeThread(input: {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
  readonly activeTurnId?: TurnId;
  readonly sessionStatus?: "starting" | "running";
  readonly projectId?: ProjectId;
}): OrchestrationReadModel["threads"][number] {
  return {
    id: input.id,
    projectId: input.projectId ?? ProjectId.makeUnsafe("project-lifecycle"),
    title: `Thread ${input.id}`,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: null,
    messages: [],
    session:
      input.activeTurnId || input.sessionStatus
        ? {
            threadId: input.id,
            status: input.sessionStatus ?? "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: input.activeTurnId ?? null,
            lastError: null,
            updatedAt: NOW,
          }
        : null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: input.deletedAt ?? null,
    archivedAt: input.archivedAt ?? null,
    ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [],
    threads,
  };
}

function eventThreadIds(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): ThreadId[] {
  const events = Array.isArray(result) ? result : [result];
  return events.map((event) => (event.payload as { threadId: ThreadId }).threadId);
}

describe("thread subtree lifecycle decisions", () => {
  const hierarchy = () => [
    makeThread({ id: PARENT }),
    makeThread({ id: CHILD, parentThreadId: PARENT }),
    makeThread({ id: GRANDCHILD, parentThreadId: CHILD }),
    makeThread({ id: DELETED_CHILD, parentThreadId: PARENT, deletedAt: NOW }),
    makeThread({ id: UNRELATED }),
  ];

  it("archives live descendants before the commanded parent", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive"),
          threadId: PARENT,
        },
        readModel: makeReadModel(hierarchy()),
      }),
    );

    expect(eventThreadIds(result)).toEqual([CHILD, GRANDCHILD, PARENT]);
    expect(
      (Array.isArray(result) ? result : [result]).every(
        (event) => event.type === "thread.archived",
      ),
    ).toBe(true);
  });

  it("skips descendants that already match the requested archive state", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-partial"),
          threadId: PARENT,
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT }),
          makeThread({ id: CHILD, parentThreadId: PARENT, archivedAt: NOW }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([PARENT]);
  });

  it("refuses to archive a subtree while any descendant turn is running", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-running-child"),
            threadId: PARENT,
          },
          readModel: makeReadModel([
            makeThread({ id: PARENT }),
            makeThread({
              id: CHILD,
              parentThreadId: PARENT,
              activeTurnId: TurnId.makeUnsafe("turn-running-child"),
            }),
          ]),
        }),
      ),
    ).rejects.toThrow("has 1 active session; stop them before command 'thread.archive'");
  });

  it("refuses to archive or delete while a descendant provider session is starting", async () => {
    const readModel = makeReadModel([
      makeThread({ id: PARENT }),
      makeThread({ id: CHILD, parentThreadId: PARENT, sessionStatus: "starting" }),
    ]);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-starting-child"),
            threadId: PARENT,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("has 1 active session");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: CommandId.makeUnsafe("cmd-delete-starting-child"),
            threadId: PARENT,
            cascadeDescendants: true,
            expectedDescendantThreadIds: [CHILD],
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("has 1 starting session");
  });

  it("restores every archived nondeleted descendant with the parent", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive"),
          threadId: PARENT,
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT, archivedAt: NOW }),
          makeThread({ id: CHILD, parentThreadId: PARENT, archivedAt: NOW }),
          makeThread({ id: GRANDCHILD, parentThreadId: CHILD, archivedAt: NOW }),
          makeThread({ id: DELETED_CHILD, parentThreadId: PARENT, deletedAt: NOW }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([CHILD, GRANDCHILD, PARENT]);
  });

  it("deletes a requested subtree deepest-first and leaves unrelated threads alone", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-subtree"),
          threadId: PARENT,
          cascadeDescendants: true,
          expectedDescendantThreadIds: [CHILD, GRANDCHILD],
        },
        readModel: makeReadModel(hierarchy()),
      }),
    );

    expect(eventThreadIds(result)).toEqual([GRANDCHILD, CHILD, PARENT]);
    expect(
      (Array.isArray(result) ? result : [result]).every((event) => event.type === "thread.deleted"),
    ).toBe(true);
  });

  it("fails closed when the confirmed descendant set is stale", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: CommandId.makeUnsafe("cmd-delete-stale-subtree"),
            threadId: PARENT,
            cascadeDescendants: true,
            expectedDescendantThreadIds: [CHILD],
          },
          readModel: makeReadModel(hierarchy()),
        }),
      ),
    ).rejects.toThrow("subtree changed before deletion");
  });

  it("contains cascade traversal to live same-project lineage", async () => {
    const deletedBridge = ThreadId.makeUnsafe("thread-deleted-bridge");
    const behindDeleted = ThreadId.makeUnsafe("thread-behind-deleted");
    const crossProject = ThreadId.makeUnsafe("thread-cross-project");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-contained-subtree"),
          threadId: PARENT,
          cascadeDescendants: true,
          expectedDescendantThreadIds: [CHILD],
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT }),
          makeThread({ id: CHILD, parentThreadId: PARENT }),
          makeThread({ id: deletedBridge, parentThreadId: PARENT, deletedAt: NOW }),
          makeThread({ id: behindDeleted, parentThreadId: deletedBridge }),
          makeThread({
            id: crossProject,
            parentThreadId: PARENT,
            projectId: ProjectId.makeUnsafe("project-other"),
          }),
        ]),
      }),
    );
    expect(eventThreadIds(result)).toEqual([CHILD, PARENT]);
  });

  it("preserves single-thread deletion when cascading is not requested", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-single"),
          threadId: PARENT,
        },
        readModel: makeReadModel(hierarchy()),
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    expect(eventThreadIds(result)).toEqual([PARENT]);
  });

  it("terminates corrupt cycles without duplicating or deleting the root twice", async () => {
    const cycle = ThreadId.makeUnsafe("thread-cycle");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-cycle"),
          threadId: PARENT,
          cascadeDescendants: true,
          expectedDescendantThreadIds: [cycle],
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT, parentThreadId: cycle }),
          makeThread({ id: cycle, parentThreadId: PARENT }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([cycle, PARENT]);
  });

  it("rejects cross-project and cyclic parent metadata", async () => {
    const otherProjectParent = ThreadId.makeUnsafe("thread-other-project-parent");
    const readModel = makeReadModel([
      makeThread({ id: PARENT }),
      makeThread({ id: CHILD, parentThreadId: PARENT }),
      makeThread({
        id: otherProjectParent,
        projectId: ProjectId.makeUnsafe("project-other"),
      }),
    ]);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-parent-cross-project"),
            threadId: CHILD,
            parentThreadId: otherProjectParent,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("must be an active thread in project");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-parent-cycle"),
            threadId: PARENT,
            parentThreadId: CHILD,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("would create a cycle");
  });

  it("rejects archived or invalid ancestor chains for new subagents", async () => {
    const archivedParent = ThreadId.makeUnsafe("thread-archived-parent");
    const orphanParent = ThreadId.makeUnsafe("thread-orphan-parent");
    const missingAncestor = ThreadId.makeUnsafe("thread-missing-ancestor");
    const makeCommand = (parentThreadId: ThreadId) => ({
      type: "thread.meta.update" as const,
      commandId: CommandId.makeUnsafe(`cmd-parent-${parentThreadId}`),
      threadId: CHILD,
      parentThreadId,
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeCommand(archivedParent),
          readModel: makeReadModel([
            makeThread({ id: CHILD }),
            makeThread({ id: archivedParent, archivedAt: NOW }),
          ]),
        }),
      ),
    ).rejects.toThrow("must be an active thread");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeCommand(orphanParent),
          readModel: makeReadModel([
            makeThread({ id: CHILD }),
            makeThread({ id: orphanParent, parentThreadId: missingAncestor }),
          ]),
        }),
      ),
    ).rejects.toThrow("Parent ancestry is incomplete");
  });

  it("allows only terminal lifecycle settlement on a soft-deleted thread", async () => {
    const activeTurnId = TurnId.makeUnsafe("turn-deleted-child");
    const deletedChild = makeThread({
      id: CHILD,
      parentThreadId: PARENT,
      deletedAt: NOW,
      activeTurnId,
    });
    const terminalResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-settle-deleted-child"),
          threadId: CHILD,
          session: {
            threadId: CHILD,
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread({ id: PARENT }), deletedChild]),
      }),
    );
    if (!("type" in terminalResult)) throw new Error("expected one terminal settlement event");
    expect(terminalResult.type).toBe("thread.session-set");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("cmd-restart-deleted-child"),
            threadId: CHILD,
            session: {
              threadId: CHILD,
              status: "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId,
              lastError: null,
              updatedAt: NOW,
            },
            createdAt: NOW,
          },
          readModel: makeReadModel([makeThread({ id: PARENT }), deletedChild]),
        }),
      ),
    ).rejects.toThrow("only accepts terminal session settlement");
  });
});
