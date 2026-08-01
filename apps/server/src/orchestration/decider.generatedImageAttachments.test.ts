import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ChatAttachmentId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-07-31T10:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const USER_MESSAGE_ID = MessageId.makeUnsafe("message-user");

async function project(
  readModel: ReturnType<typeof createEmptyReadModel>,
  event: Omit<OrchestrationEvent, "sequence">,
  sequence: number,
) {
  return Effect.runPromise(projectEvent(readModel, { ...event, sequence } as OrchestrationEvent));
}

async function readModelWithUserMessage() {
  const projectCommandId = CommandId.makeUnsafe("command-project");
  const withProject = await project(
    createEmptyReadModel(NOW),
    {
      eventId: EventId.makeUnsafe("event-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: projectCommandId,
      causationEventId: null,
      correlationId: projectCommandId,
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
    },
    1,
  );
  const threadCommandId = CommandId.makeUnsafe("command-thread");
  const withThread = await project(
    withProject,
    {
      eventId: EventId.makeUnsafe("event-thread"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: threadCommandId,
      causationEventId: null,
      correlationId: threadCommandId,
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
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
    },
    2,
  );
  const messageCommandId = CommandId.makeUnsafe("command-user-message");
  return project(
    withThread,
    {
      eventId: EventId.makeUnsafe("event-user-message"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: messageCommandId,
      causationEventId: null,
      correlationId: messageCommandId,
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        messageId: USER_MESSAGE_ID,
        role: "user",
        text: "Keep this user message intact.",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    3,
  );
}

describe("thread.message.assistant.attachments.add", () => {
  it("fails closed when its message id belongs to a user message", async () => {
    const readModel = await readModelWithUserMessage();
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.message.assistant.attachments.add",
            commandId: CommandId.makeUnsafe("command-add-assistant-image"),
            threadId: THREAD_ID,
            messageId: USER_MESSAGE_ID,
            attachments: [
              {
                type: "image",
                id: "thread-1-generated-image" as ChatAttachmentId,
                name: "generated-image.png",
                mimeType: "image/png",
                sizeBytes: 12,
              },
            ],
            createdAt: NOW,
          },
        }),
      ),
    );

    expect(error._tag).toBe("OrchestrationCommandInvariantError");
    expect(error.detail).toContain("non-assistant message");
    const userMessage = readModel.threads[0]?.messages.find(
      (message) => message.id === USER_MESSAGE_ID,
    );
    expect(userMessage).toMatchObject({
      role: "user",
      text: "Keep this user message intact.",
    });
    expect(userMessage?.attachments ?? []).toEqual([]);
  });
});
