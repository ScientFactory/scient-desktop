import * as Schema from "effect/Schema";
import { SelectedScientSkillNames } from "./scientSkillSelection.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

// SCIENT-FORK:START — conversation context handed to a provider session that
// does not hold it natively (a fork, or a session that lost its history). It is
// budgeted against the model's context window by its producer, so it is bounded
// here only by a transport ceiling, never by the user-input limit.
const PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS = 4_000_000;
// SCIENT-FORK:END

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  selectedScientSkillNames: Schema.optional(SelectedScientSkillNames),
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  // SCIENT-FORK: prepended to the prepared input immediately before dispatch.
  contextPreamble: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_CONTEXT_PREAMBLE_MAX_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}
