import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-orchestration-engine-test-",
  });
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createFileBackedOrchestrationSystem(dbPath: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-orchestration-engine-restart-test-",
  });
  const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(persistenceLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("returns deterministic read models for repeated reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-1-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.run(engine.getReadModel());
    const readModelB = await system.run(engine.getReadModel());
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("serializes concurrent forks into distinct authoritative title ordinals", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-concurrent-forks");
    const sourceThreadId = ThreadId.makeUnsafe("thread-concurrent-forks-source");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-concurrent-forks-create"),
        projectId,
        title: "Concurrent Fork Project",
        workspaceRoot: "/tmp/project-concurrent-forks",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-concurrent-forks-source-create"),
        threadId: sourceThreadId,
        projectId,
        title: "Greeting",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const forkCommand = (suffix: string) => ({
      type: "thread.fork.create" as const,
      commandId: CommandId.makeUnsafe(`cmd-thread-concurrent-fork-${suffix}`),
      threadId: ThreadId.makeUnsafe(`thread-concurrent-fork-${suffix}`),
      sourceThreadId,
      projectId,
      title: "stale client title",
      modelSelection: {
        provider: "codex" as const,
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      envMode: "local" as const,
      branch: null,
      worktreePath: null,
      importedMessages: [],
      createdAt,
    });
    await Promise.all([
      system.run(engine.dispatch(forkCommand("a"))),
      system.run(engine.dispatch(forkCommand("b"))),
    ]);

    const forkedThreads = (await system.run(engine.getReadModel())).threads
      .filter((thread) => thread.forkSourceThreadId === sourceThreadId)
      .toSorted((left, right) => (left.forkTitleOrdinal ?? 0) - (right.forkTitleOrdinal ?? 0));
    expect(
      forkedThreads.map((thread) => ({
        title: thread.title,
        base: thread.forkTitleBase,
        ordinal: thread.forkTitleOrdinal,
      })),
    ).toEqual([
      { title: "Greeting (2)", base: "Greeting", ordinal: 2 },
      { title: "Greeting (3)", base: "Greeting", ordinal: 3 },
    ]);
    await system.dispose();
  });

  it("validates a post-restart fork against the complete persisted transcript", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "scient-fork-restart-"));
    const dbPath = path.join(tempDirectory, "orchestration.sqlite");
    const projectId = asProjectId("project-restart-fork");
    const sourceThreadId = ThreadId.makeUnsafe("thread-restart-fork-source");
    const oldCreatedAt = "2026-07-22T10:00:00.000Z";
    const newCreatedAt = "2026-07-22T10:01:00.000Z";
    let firstSystem: Awaited<ReturnType<typeof createFileBackedOrchestrationSystem>> | null = null;
    let restartedSystem: Awaited<ReturnType<typeof createFileBackedOrchestrationSystem>> | null =
      null;
    try {
      firstSystem = await createFileBackedOrchestrationSystem(dbPath);
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-restart-fork-create"),
          projectId,
          title: "Restart Fork Project",
          workspaceRoot: "/tmp/project-restart-fork",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: oldCreatedAt,
        }),
      );
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-restart-fork-create"),
          threadId: sourceThreadId,
          projectId,
          title: "Restart source",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: oldCreatedAt,
        }),
      );
      await firstSystem.run(
        firstSystem.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-restart-fork-old-messages"),
          threadId: sourceThreadId,
          messages: [
            {
              messageId: asMessageId("restart-old-user"),
              role: "user",
              text: "Old question",
              createdAt: oldCreatedAt,
              updatedAt: oldCreatedAt,
            },
            {
              messageId: asMessageId("restart-old-assistant"),
              role: "assistant",
              text: "Old answer",
              createdAt: "2026-07-22T10:00:01.000Z",
              updatedAt: "2026-07-22T10:00:01.000Z",
            },
          ],
          createdAt: oldCreatedAt,
        }),
      );
      await firstSystem.dispose();
      firstSystem = null;

      restartedSystem = await createFileBackedOrchestrationSystem(dbPath);
      await restartedSystem.run(
        restartedSystem.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-restart-fork-new-messages"),
          threadId: sourceThreadId,
          messages: [
            {
              messageId: asMessageId("restart-new-user"),
              role: "user",
              text: "New question",
              createdAt: newCreatedAt,
              updatedAt: newCreatedAt,
            },
            {
              messageId: asMessageId("restart-new-assistant"),
              role: "assistant",
              text: "New answer",
              createdAt: "2026-07-22T10:01:01.000Z",
              updatedAt: "2026-07-22T10:01:01.000Z",
            },
          ],
          createdAt: newCreatedAt,
        }),
      );

      await expect(
        restartedSystem.run(
          restartedSystem.engine.dispatch({
            type: "thread.fork.create",
            commandId: CommandId.makeUnsafe("cmd-restart-fork-create-destination"),
            threadId: ThreadId.makeUnsafe("thread-restart-fork-destination"),
            sourceThreadId,
            sourceMessageId: asMessageId("restart-new-assistant"),
            projectId,
            title: "stale client title",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            envMode: "local",
            branch: null,
            worktreePath: null,
            importedMessages: [
              ["fork-old-user", "user", "Old question", oldCreatedAt],
              ["fork-old-assistant", "assistant", "Old answer", "2026-07-22T10:00:01.000Z"],
              ["fork-new-user", "user", "New question", newCreatedAt],
              ["fork-new-assistant", "assistant", "New answer", "2026-07-22T10:01:01.000Z"],
            ].map(([id, role, text, createdAt]) => ({
              messageId: asMessageId(id!),
              role: role as "user" | "assistant",
              text: text!,
              createdAt: createdAt!,
              updatedAt: createdAt!,
            })),
            createdAt: "2026-07-22T10:02:00.000Z",
          }),
        ),
      ).resolves.toEqual(expect.objectContaining({ sequence: expect.any(Number) }));

      const destination = (
        await restartedSystem.run(restartedSystem.engine.getReadModel())
      ).threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-restart-fork-destination"),
      );
      expect(destination?.messages.map((message) => message.text)).toEqual([
        "Old question",
        "Old answer",
        "New question",
        "New answer",
      ]);
    } finally {
      if (firstSystem) await firstSystem.dispose();
      if (restartedSystem) await restartedSystem.dispose();
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("validates message-boundary forks against transcripts beyond the UI message cap", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-long-fork");
    const sourceThreadId = ThreadId.makeUnsafe("thread-long-fork-source");
    const baseTimestamp = Date.parse("2026-07-22T10:00:00.000Z");
    const sourceMessages = Array.from({ length: 2_002 }, (_, index) => {
      const sequence = String(index).padStart(4, "0");
      const createdAt = new Date(baseTimestamp + index).toISOString();
      return {
        messageId: asMessageId(`long-source-${sequence}`),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Long transcript message ${sequence}`,
        createdAt,
        updatedAt: createdAt,
      };
    });

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-long-fork-create"),
          projectId,
          title: "Long fork project",
          workspaceRoot: "/tmp/project-long-fork",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: sourceMessages[0]!.createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-long-fork-source-create"),
          threadId: sourceThreadId,
          projectId,
          title: "Long source",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: sourceMessages[0]!.createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-thread-long-fork-source-import"),
          threadId: sourceThreadId,
          messages: sourceMessages,
          createdAt: sourceMessages.at(-1)!.createdAt,
        }),
      );

      await expect(
        system.run(
          engine.dispatch({
            type: "thread.fork.create",
            commandId: CommandId.makeUnsafe("cmd-thread-long-fork-create"),
            threadId: ThreadId.makeUnsafe("thread-long-fork-destination"),
            sourceThreadId,
            sourceMessageId: sourceMessages.at(-1)!.messageId,
            projectId,
            title: "Long fork",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            envMode: "local",
            branch: null,
            worktreePath: null,
            importedMessages: sourceMessages.map((message, index) => ({
              ...message,
              messageId: asMessageId(`long-fork-${String(index).padStart(4, "0")}`),
            })),
            createdAt: new Date(baseTimestamp + sourceMessages.length).toISOString(),
          }),
        ),
      ).resolves.toEqual(expect.objectContaining({ sequence: expect.any(Number) }));

      const destination = (await system.run(engine.getReadModel())).threads.find(
        (thread) => thread.id === ThreadId.makeUnsafe("thread-long-fork-destination"),
      );
      expect(destination?.messages).toHaveLength(2_000);
      expect(destination?.messages.at(-1)?.text).toBe("Long transcript message 2001");
    } finally {
      await system.dispose();
    }
  });

  it("validates hot same-timestamp fork messages in persistent projection order", async () => {
    const createdAt = "2026-07-22T10:00:00.000Z";
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-same-time-fork");
    const sourceThreadId = ThreadId.makeUnsafe("thread-same-time-fork-source");

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-same-time-fork-create"),
          projectId,
          title: "Same-time fork project",
          workspaceRoot: "/tmp/project-same-time-fork",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-same-time-fork-source-create"),
          threadId: sourceThreadId,
          projectId,
          title: "Same-time source",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      // Deliberately append in the opposite order from the projection's
      // created_at/message_id ordering to exercise the hot overlay.
      await system.run(
        engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("cmd-thread-same-time-fork-source-import"),
          threadId: sourceThreadId,
          messages: [
            {
              messageId: asMessageId("same-time-z-assistant"),
              role: "assistant",
              text: "Same-time answer",
              createdAt,
              updatedAt: createdAt,
            },
            {
              messageId: asMessageId("same-time-a-user"),
              role: "user",
              text: "Same-time question",
              createdAt,
              updatedAt: createdAt,
            },
          ],
          createdAt,
        }),
      );

      await expect(
        system.run(
          engine.dispatch({
            type: "thread.fork.create",
            commandId: CommandId.makeUnsafe("cmd-thread-same-time-fork-create"),
            threadId: ThreadId.makeUnsafe("thread-same-time-fork-destination"),
            sourceThreadId,
            sourceMessageId: asMessageId("same-time-z-assistant"),
            projectId,
            title: "Same-time fork",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            envMode: "local",
            branch: null,
            worktreePath: null,
            importedMessages: [
              {
                messageId: asMessageId("same-time-fork-a-user"),
                role: "user",
                text: "Same-time question",
                createdAt,
                updatedAt: createdAt,
              },
              {
                messageId: asMessageId("same-time-fork-z-assistant"),
                role: "assistant",
                text: "Same-time answer",
                createdAt,
                updatedAt: createdAt,
              },
            ],
            createdAt,
          }),
        ),
      ).resolves.toEqual(expect.objectContaining({ sequence: expect.any(Number) }));
    } finally {
      await system.dispose();
    }
  });

  it("rejects a fork import that reuses a source message id without moving the source row", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-fork-message-id-collision");
    const sourceThreadId = ThreadId.makeUnsafe("thread-fork-message-id-collision-source");
    const sourceMessageId = asMessageId("message-fork-message-id-collision-source");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-fork-message-id-collision"),
        projectId,
        title: "Fork collision project",
        workspaceRoot: "/tmp/project-fork-message-id-collision",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-fork-message-id-collision-source"),
        threadId: sourceThreadId,
        projectId,
        title: "Source",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-fork-message-id-collision-source"),
        threadId: sourceThreadId,
        message: {
          messageId: sourceMessageId,
          role: "user",
          text: "Source message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("cmd-fork-message-id-collision"),
          threadId: ThreadId.makeUnsafe("thread-fork-message-id-collision-destination"),
          sourceThreadId,
          sourceMessageId,
          projectId,
          title: "Source",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          envMode: "local",
          branch: null,
          worktreePath: null,
          importedMessages: [
            {
              messageId: sourceMessageId,
              role: "user",
              text: "Source message",
              attachments: [],
              createdAt,
              updatedAt: createdAt,
            },
          ],
          createdAt,
        }),
      ),
    ).rejects.toThrow("must be unique and must not already exist");

    const sourceThread = (await system.run(engine.getReadModel())).threads.find(
      (thread) => thread.id === sourceThreadId,
    );
    expect(sourceThread?.messages.map((message) => message.id)).toEqual([sourceMessageId]);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-create"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-replay-delete"),
        threadId: ThreadId.makeUnsafe("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-stream-thread-update"),
          threadId: ThreadId.makeUnsafe("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-turn-diff-create"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-complete"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-orchestration-engine-test-",
    });

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "failed unexpectedly",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("keeps processing later commands after an unexpected worker defect", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldDieProjection = true;
    const defectiveProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: (event) => {
        if (
          shouldDieProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-project-defect-1")
        ) {
          shouldDieProjection = false;
          return Effect.die("projection defect");
        }
        return Effect.void;
      },
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, defectiveProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-1"),
          projectId: asProjectId("project-defect-1"),
          title: "Defective Project",
          workspaceRoot: "/tmp/project-defect-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-2"),
          projectId: asProjectId("project-defect-2"),
          title: "Recovered Project",
          workspaceRoot: "/tmp/project-defect-2",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sequence: expect.any(Number),
      }),
    );

    const eventsAfterRecovery = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRecovery.map((event) => event.commandId)).toEqual([
      CommandId.makeUnsafe("cmd-project-defect-1"),
      CommandId.makeUnsafe("cmd-project-defect-2"),
    ]);
    expect(eventsAfterRecovery.every((event) => event.type === "project.created")).toBe(true);

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
      projectDeferredEvent: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-invariant-missing-thread"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("schedules one deferred projection catch-up after a deferred projection failure", async () => {
    let bootstrapCalls = 0;
    let deferredCalls = 0;
    let resolveRecoveryBootstrap: (() => void) | null = null;
    const recoveryBootstrap = new Promise<void>((resolve) => {
      resolveRecoveryBootstrap = resolve;
    });

    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.sync(() => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 2) {
          resolveRecoveryBootstrap?.();
        }
      }),
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
      projectDeferredEvent: () => {
        deferredCalls += 1;
        if (deferredCalls === 1) {
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.deferredProjection",
              detail: "deferred projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-deferred-recovery"),
        projectId: asProjectId("project-deferred-recovery"),
        title: "Deferred Recovery Project",
        workspaceRoot: "/tmp/project-deferred-recovery",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        projectId: asProjectId("project-deferred-recovery"),
        title: "deferred-recovery",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-deferred-recovery"),
        threadId: ThreadId.makeUnsafe("thread-deferred-recovery"),
        message: {
          messageId: asMessageId("msg-deferred-recovery"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await recoveryBootstrap;

    expect(result.sequence).toBe(4);
    expect(deferredCalls).toBeGreaterThanOrEqual(1);
    expect(bootstrapCalls).toBe(2);

    await runtime.dispose();
  });

  it("retires an empty existing project when re-adding the same workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stale-create"),
        projectId: asProjectId("project-stale"),
        title: "Stale Project",
        workspaceRoot: "/tmp/readd-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-readd-create"),
          projectId: asProjectId("project-readd"),
          title: "Readded Project",
          workspaceRoot: "/tmp/readd-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual({ sequence: 3 });

    const readModel = await system.run(engine.getReadModel());
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-stale"))?.deletedAt,
    ).toBe(createdAt);
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-readd"))?.deletedAt,
    ).toBeNull();

    await system.dispose();
  });

  it("keeps rejecting a duplicate workspace root when the existing project has threads", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-create"),
        projectId: asProjectId("project-active"),
        title: "Active Project",
        workspaceRoot: "/tmp/active-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-active"),
        projectId: asProjectId("project-active"),
        title: "active",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-active-duplicate-create"),
          projectId: asProjectId("project-active-duplicate"),
          title: "Active Duplicate",
          workspaceRoot: "/tmp/active-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects duplicate Studio workspace containers", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-project-create"),
        projectId: asProjectId("project-studio"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-studio-project-duplicate-create"),
          projectId: asProjectId("project-studio-duplicate"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/tmp/synara-studio",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects Studio and regular projects claiming each other's workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-create"),
        projectId: asProjectId("project-cross-kind-studio"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-project-create"),
        projectId: asProjectId("project-cross-kind-app"),
        kind: "project",
        title: "App",
        workspaceRoot: "/tmp/synara-cross-kind-app",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    // Adding the Studio container's folder as a regular project must not create a second
    // active project on that root (the empty container would otherwise be silently retired).
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-on-studio-root"),
          projectId: asProjectId("project-on-studio-root"),
          kind: "project",
          title: "Studio folder",
          workspaceRoot: "/tmp/synara-cross-kind-studio",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Creating a Studio container on a root an existing regular project owns must fail too.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-on-project-root"),
          projectId: asProjectId("project-studio-on-project-root"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/tmp/synara-cross-kind-app",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Root moves are covered by the same cross-kind ownership rule.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-root-update"),
          projectId: asProjectId("project-cross-kind-app"),
          workspaceRoot: "/tmp/synara-cross-kind-studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // A kind-only update must not carry an existing pin onto a kind that can never be pinned.
    await system.run(
      engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-pin-app"),
        projectId: asProjectId("project-cross-kind-app"),
        isPinned: true,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-pinned-kind-change"),
          projectId: asProjectId("project-cross-kind-app"),
          kind: "studio",
          workspaceRoot: "/tmp/synara-cross-kind-pinned-studio",
        }),
      ),
    ).rejects.toThrow("Only projects can be pinned.");

    // A kind-only update must not bypass ownership either: a chat project sitting on an owned
    // root cannot become a workspace-owning kind without the root check running.
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-create"),
        projectId: asProjectId("project-cross-kind-chat"),
        kind: "chat",
        title: "Home",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-kind-only-update"),
          projectId: asProjectId("project-cross-kind-chat"),
          kind: "studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects moving a Studio container onto another Studio workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-source-create"),
        projectId: asProjectId("project-studio-source"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-source",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-target-create"),
        projectId: asProjectId("project-studio-target"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-target",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-target-root-update"),
          projectId: asProjectId("project-studio-target"),
          workspaceRoot: "/tmp/synara-studio-source",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
