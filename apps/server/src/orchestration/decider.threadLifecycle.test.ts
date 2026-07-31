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
}): OrchestrationReadModel["threads"][number] {
  return {
    id: input.id,
    projectId: ProjectId.makeUnsafe("project-lifecycle"),
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
    session: input.activeTurnId
      ? {
          threadId: input.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: input.activeTurnId,
          lastError: null,
          updatedAt: NOW,
        }
      : null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: input.deletedAt ?? null,
    ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
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
    ).rejects.toThrow("has 1 running turn; stop them before command 'thread.archive'");
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
        },
        readModel: makeReadModel(hierarchy()),
      }),
    );

    expect(eventThreadIds(result)).toEqual([GRANDCHILD, CHILD, PARENT]);
    expect(
      (Array.isArray(result) ? result : [result]).every((event) => event.type === "thread.deleted"),
    ).toBe(true);
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
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT, parentThreadId: cycle }),
          makeThread({ id: cycle, parentThreadId: PARENT }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([cycle, PARENT]);
  });
});
