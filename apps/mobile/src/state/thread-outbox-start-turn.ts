import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";

import type { QueuedThreadMessage, ThreadSettingsSnapshot } from "./thread-outbox-model";
import { serializeComposerMessageForServer, uploadedComposerContext } from "../lib/composerContext";
import { deriveThreadTitleSeed } from "../lib/projectThreadStartTurn";
import type { UploadedMobileAttachment } from "../lib/attachmentUpload";

/** Replay the captured intent after uploads and settings resolution, including legacy queue rows. */
export function buildExistingThreadOutboxStartTurnInput(input: {
  readonly message: QueuedThreadMessage;
  readonly settings: ThreadSettingsSnapshot;
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
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
      ),
      attachments,
    },
    ...settings,
    createdAt: message.createdAt,
  };
}
