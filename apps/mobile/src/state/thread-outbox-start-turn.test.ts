import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { buildExistingThreadOutboxStartTurnInput } from "./thread-outbox-start-turn";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("outbox-command"),
  messageId: MessageId.make("message"),
  text: "$pdf-authoring Explain this result",
  attachments: [],
  createdAt: "2026-10-03T10:00:00.000Z",
};
const settings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

function delivered(stored: QueuedThreadMessage, itemCount = 2) {
  return buildExistingThreadOutboxStartTurnInput({
    message: stored,
    settings,
    attachments: [],
    itemCount,
  });
}

describe("existing thread outbox delivery", () => {
  it.each(["auto", "queue", "steer", "restart"] as const)(
    "replays captured %s after storage round-trip",
    (dispatchMode) => {
      const stored = decodeQueuedThreadMessage(
        encodeQueuedThreadMessage({ ...message, dispatchMode }),
      );
      const command = delivered(stored);
      expect(command.dispatchMode).toBe(dispatchMode);
      expect(command.commandId).toBe(message.commandId);
      expect(command.selectedScientSkillNames).toEqual(["pdf-authoring"]);
      expect(command).not.toHaveProperty("titleSeed");
    },
  );

  it("keeps always-queue behavior for old rows without a dispatch choice", () => {
    const stored = decodeQueuedThreadMessage({ ...message, schemaVersion: 1 });
    expect(delivered(stored).dispatchMode).toBe("queue");
  });

  it("seeds the first message from readable citation text", () => {
    const text = serializeAssistantCitation({
      version: 1,
      environmentId: message.environmentId,
      threadId: message.threadId,
      messageId: message.messageId,
      text: "Explain the measured result",
      start: 0,
      end: 27,
      prefix: "",
      suffix: "",
    });
    expect(delivered({ ...message, text }, 0).titleSeed).toBe("Explain the measured result");
    expect(delivered({ ...message, text }, 2)).not.toHaveProperty("titleSeed");
  });

  it("seeds attachment-only first messages from prepared attachment names", () => {
    const command = buildExistingThreadOutboxStartTurnInput({
      message: { ...message, text: "" },
      settings,
      itemCount: 0,
      attachments: [
        {
          type: "image",
          id: "uploaded",
          name: "experiment.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ],
    });
    expect(command.titleSeed).toBe("Image: experiment.png");
    expect(command.message.attachments[0]?.id).toBe("uploaded");
  });
});
