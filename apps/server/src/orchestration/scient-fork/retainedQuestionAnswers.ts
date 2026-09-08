import {
  UserInputAttachmentAnswerPayload,
  type ChatAttachment,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAnswer = Schema.decodeUnknownOption(UserInputAttachmentAnswerPayload);

export interface RetainedQuestionAnswer {
  readonly activity: OrchestrationThreadActivity;
  readonly answer: UserInputAttachmentAnswerPayload;
}

/** One selection policy for fork admission, durable copying, and provider context.
 * Only submitted native answers belong here. Message-mode answers already live in
 * the message transcript; pending questions and client-side drafts are never read.
 */
export function retainQuestionAnswers(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  retainedTurnIds: ReadonlySet<string>,
): { readonly answers: ReadonlyArray<RetainedQuestionAnswer>; readonly error: string | null } {
  const answers: RetainedQuestionAnswer[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.answer-submitted" || seen.has(activity.id)) continue;
    if (activity.turnId === null) {
      if (retainedTurnIds.size === 0) continue;
      return {
        answers: [],
        error:
          "A submitted question answer has no recorded turn. Its fork boundary cannot be determined safely.",
      };
    }
    if (!retainedTurnIds.has(activity.turnId)) continue;
    const answer = decodeAnswer(activity.payload);
    if (Option.isNone(answer)) {
      return {
        answers: [],
        error:
          "A retained question answer cannot be decoded safely. The conversation has not been forked.",
      };
    }
    seen.add(activity.id);
    answers.push({ activity, answer: answer.value });
  }
  return { answers, error: null };
}

export function questionAnswerAttachments(
  answers: ReadonlyArray<RetainedQuestionAnswer>,
): ReadonlyArray<ChatAttachment> {
  return answers.flatMap(({ answer }) => Object.values(answer.attachmentsByQuestionId).flat());
}
