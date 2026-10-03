import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";

import type { QueuedThreadMessage, ThreadSettingsSnapshot } from "../state/thread-outbox-model";
import { serializeComposerMessageForServer, uploadedComposerContext } from "./composerContext";
import { deriveThreadTitleSeed } from "./projectThreadStartTurn";
import type { UploadedMobileAttachment } from "./attachmentUpload";

/** Replay the captured intent after uploads and settings resolution, including legacy queue rows. */
export function buildExistingThreadOutboxStartTurnInput(input: {
  readonly message: QueuedThreadMessage;
  readonly settings: ThreadSettingsSnapshot;
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  readonly inlineMessageContext: boolean;
  readonly itemCount: number;
}): StartThreadTurnInput {
  const { message, settings, attachments } = input;
  return {
    commandId: message.commandId,
    selectedScientSkillNames: collectSelectedScientSkillNames(message.text),
    threadId: message.threadId,
    dispatchMode: message.dispatchMode ?? "queue",
    ...(input.itemCount === 0
      ? { titleSeed: deriveThreadTitleSeed({ text: message.text, attachments }) }
      : {}),
    message: {
      messageId: message.messageId,
      role: "user",
      ...serializeComposerMessageForServer(
        message.text,
        uploadedComposerContext(message.context, message.attachments, attachments),
        input.inlineMessageContext,
      ),
      attachments,
    },
    ...settings,
    createdAt: message.createdAt,
  };
}
