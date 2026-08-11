import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class GeneralChatTaskRequiredError extends Schema.TaggedErrorClass<GeneralChatTaskRequiredError>()(
  "GeneralChatTaskRequiredError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export function validateGeneralChatCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly initialMessageText: string;
}): GeneralChatTaskRequiredError | null {
  return input.initialMessageText.trim().length === 0
    ? new GeneralChatTaskRequiredError({ environmentId: input.environmentId })
    : null;
}
