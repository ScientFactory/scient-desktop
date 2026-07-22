import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const ROOT_THREAD_ID = ThreadId.makeUnsafe("thread-root");
const NOW = "2026-07-22T10:00:00.000Z";

const eventId = (value: string) => EventId.makeUnsafe(value);
const commandId = (value: string) => CommandId.makeUnsafe(value);

async function createRootReadModel(title = "Greeting") {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: eventId("event-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: commandId("command-project"),
      causationEventId: null,
      correlationId: commandId("command-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: eventId("event-root"),
      aggregateKind: "thread",
      aggregateId: ROOT_THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: commandId("command-root"),
      causationEventId: null,
      correlationId: commandId("command-root"),
      metadata: {},
      payload: {
        threadId: ROOT_THREAD_ID,
        projectId: PROJECT_ID,
        title,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        forkSourceThreadId: null,
        forkSourceMessageId: null,
        forkTitleBase: null,
        forkTitleOrdinal: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

const forkCommand = (input: {
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly title?: string;
  readonly sidechatSourceThreadId?: string;
}) => ({
  type: "thread.fork.create" as const,
  commandId: commandId(`command-${input.threadId}`),
  threadId: ThreadId.makeUnsafe(input.threadId),
  sourceThreadId: ThreadId.makeUnsafe(input.sourceThreadId),
  ...(input.sidechatSourceThreadId
    ? { sidechatSourceThreadId: ThreadId.makeUnsafe(input.sidechatSourceThreadId) }
    : {}),
  projectId: PROJECT_ID,
  title: input.title ?? "stale client title",
  modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  runtimeMode: "approval-required" as const,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  envMode: "local" as const,
  branch: null,
  worktreePath: null,
  importedMessages: [],
  createdAt: NOW,
});

async function decideCreatedEvent(
  readModel: OrchestrationReadModel,
  command: ReturnType<typeof forkCommand>,
) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const event = (Array.isArray(result) ? result : [result])[0];
  expect(event?.type).toBe("thread.created");
  if (!event || event.type !== "thread.created") {
    throw new Error("Expected thread.created event");
  }
  return event;
}

async function applyEvent(
  readModel: OrchestrationReadModel,
  event: Omit<OrchestrationEvent, "sequence">,
  sequence: number,
) {
  return Effect.runPromise(projectEvent(readModel, { ...event, sequence } as OrchestrationEvent));
}

describe("thread.fork.create title allocation", () => {
  it("allocates repeated fork titles from authoritative serialized state", async () => {
    const rootModel = await createRootReadModel();
    const fork2Event = await decideCreatedEvent(
      rootModel,
      forkCommand({ threadId: "fork-2", sourceThreadId: ROOT_THREAD_ID }),
    );
    expect(fork2Event.payload).toMatchObject({
      title: "Greeting (2)",
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 2,
    });

    const withFork2 = await applyEvent(rootModel, fork2Event, 3);
    const fork3Event = await decideCreatedEvent(
      withFork2,
      forkCommand({ threadId: "fork-3", sourceThreadId: ROOT_THREAD_ID }),
    );
    expect(fork3Event.payload).toMatchObject({
      title: "Greeting (3)",
      forkTitleBase: "Greeting",
      forkTitleOrdinal: 3,
    });
  });

  it("starts a new series after the source fork is manually renamed", async () => {
    const rootModel = await createRootReadModel();
    const fork2Event = await decideCreatedEvent(
      rootModel,
      forkCommand({ threadId: "fork-2", sourceThreadId: ROOT_THREAD_ID }),
    );
    const withFork2 = await applyEvent(rootModel, fork2Event, 3);
    const renameResult = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: withFork2,
        command: {
          type: "thread.meta.update",
          commandId: commandId("command-rename-fork-2"),
          threadId: ThreadId.makeUnsafe("fork-2"),
          title: "Experiment (2026)",
        },
      }),
    );
    const renameEvent = (Array.isArray(renameResult) ? renameResult : [renameResult])[0];
    if (!renameEvent || renameEvent.type !== "thread.meta-updated") {
      throw new Error("Expected thread.meta-updated event");
    }
    const renamedModel = await applyEvent(withFork2, renameEvent, 4);

    const renamedForkEvent = await decideCreatedEvent(
      renamedModel,
      forkCommand({ threadId: "experiment-2", sourceThreadId: "fork-2" }),
    );
    expect(renamedForkEvent.payload).toMatchObject({
      title: "Experiment (2026) (2)",
      forkTitleBase: "Experiment (2026)",
      forkTitleOrdinal: 2,
    });
  });

  it("preserves sidechat-owned titles and excludes them from fork numbering", async () => {
    const rootModel = await createRootReadModel();
    const sidechatEvent = await decideCreatedEvent(
      rootModel,
      forkCommand({
        threadId: "sidechat",
        sourceThreadId: ROOT_THREAD_ID,
        sidechatSourceThreadId: ROOT_THREAD_ID,
        title: "Sidechat: Greeting",
      }),
    );
    expect(sidechatEvent.payload).toMatchObject({
      title: "Sidechat: Greeting",
      forkTitleBase: null,
      forkTitleOrdinal: null,
    });

    const withSidechat = await applyEvent(rootModel, sidechatEvent, 3);
    const fork2Event = await decideCreatedEvent(
      withSidechat,
      forkCommand({ threadId: "fork-2", sourceThreadId: ROOT_THREAD_ID }),
    );
    expect(fork2Event.payload.title).toBe("Greeting (2)");
  });
});
