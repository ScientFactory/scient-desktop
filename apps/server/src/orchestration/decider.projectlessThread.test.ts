import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const projectlessCreate = (workspaceRoot: string | null) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`cmd-projectless-${workspaceRoot ?? "missing"}`),
  threadId: ThreadId.make(`thread-projectless-${workspaceRoot ?? "missing"}`),
  projectId: null,
  workspaceRoot,
  title: "No project",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdAt: now,
});

function relocationReadModel(input?: {
  sessionStatus?: OrchestrationSessionStatus | null;
  threadProjectId?: ProjectId | null;
  targetDeletedAt?: string | null;
  workInFlight?: boolean;
}): OrchestrationReadModel {
  const targetProjectId = ProjectId.make("project-target");
  const sessionStatus = input?.sessionStatus ?? null;
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: targetProjectId,
        title: "Research project",
        workspaceRoot: "/tmp/research-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: input?.targetDeletedAt ?? null,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-general"),
        projectId: input?.threadProjectId ?? null,
        workspaceRoot: "/tmp/environment-root",
        title: "Quick chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "quick-chat-branch",
        worktreePath: "/tmp/quick-chat-worktree",
        latestTurn:
          input?.workInFlight === true
            ? {
                turnId: TurnId.make("turn-running"),
                state: "running",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                assistantMessageId: MessageId.make("assistant-running"),
              }
            : null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session:
          sessionStatus === null
            ? null
            : {
                threadId: ThreadId.make("thread-general"),
                status: sessionStatus,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
      },
    ],
    updatedAt: now,
  };
}

const moveQuickChatCommand = {
  type: "thread.meta.update" as const,
  commandId: CommandId.make("cmd-move-quick-chat"),
  threadId: ThreadId.make("thread-general"),
  moveToProjectId: ProjectId.make("project-target"),
};

it.layer(NodeServices.layer)("decider projectless threads", (it) => {
  it.effect("carries assistant attachments into the canonical message event", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-assistant-image-complete"),
          threadId: ThreadId.make("thread-general"),
          messageId: MessageId.make("assistant-image"),
          attachments: [
            {
              type: "image",
              id: "thread-general-11111111-1111-4111-8111-111111111111",
              name: "generated-image.png",
              mimeType: "image/png",
              sizeBytes: 12,
            },
          ],
          createdAt: now,
        },
        readModel: relocationReadModel(),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.message-sent");
      if (event.type === "thread.message-sent") {
        expect(event.payload.role).toBe("assistant");
        expect(event.payload.attachments).toHaveLength(1);
        expect(event.payload.attachments?.[0]?.name).toBe("generated-image.png");
      }
    }),
  );

  it.effect("creates a thread with an explicit environment workspace root", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: projectlessCreate("/tmp/environment-root"),
        readModel: createEmptyReadModel(now),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.created");
      expect(event.payload.projectId).toBeNull();
      expect(event.payload.workspaceRoot).toBe("/tmp/environment-root");
    }),
  );

  it.effect("rejects a thread with neither a project nor workspace root", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: projectlessCreate(null),
          readModel: createEmptyReadModel(now),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("moves one stopped quick chat into a project without changing its identity", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: moveQuickChatCommand,
        readModel: relocationReadModel({ sessionStatus: "stopped" }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toMatchObject({
          threadId: ThreadId.make("thread-general"),
          projectId: ProjectId.make("project-target"),
          workspaceRoot: null,
          branch: null,
          worktreePath: null,
        });
      }
    }),
  );

  it.effect("rejects relocation while the provider session is still live", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: moveQuickChatCommand,
          readModel: relocationReadModel({ sessionStatus: "ready" }),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects relocating a thread that already belongs to another project", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: moveQuickChatCommand,
          readModel: relocationReadModel({
            threadProjectId: ProjectId.make("project-existing"),
          }),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects retrying relocation after the thread already reached the target project", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: moveQuickChatCommand,
          readModel: relocationReadModel({
            sessionStatus: "stopped",
            threadProjectId: ProjectId.make("project-target"),
          }),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects relocation while a turn is running", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: moveQuickChatCommand,
          readModel: relocationReadModel({ sessionStatus: "stopped", workInFlight: true }),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a deleted destination project", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: moveQuickChatCommand,
          readModel: relocationReadModel({ targetDeletedAt: now }),
        }),
      );

      expect(result._tag).toBe("Failure");
    }),
  );
});
