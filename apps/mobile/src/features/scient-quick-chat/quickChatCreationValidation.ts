import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class QuickChatTaskRequiredError extends Schema.TaggedErrorClass<QuickChatTaskRequiredError>()(
  "QuickChatTaskRequiredError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export function validateQuickChatCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly initialMessageText: string;
}): QuickChatTaskRequiredError | null {
  return input.initialMessageText.trim().length === 0
    ? new QuickChatTaskRequiredError({ environmentId: input.environmentId })
    : null;
}
