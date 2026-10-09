import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { expandComposerCitationsForProvider } from "@t3tools/shared/composerCitations";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";

/** Complete current material; inherited history has its separate receiving budget. */
export function formatScientCurrentInput(input: {
  readonly text: string;
  readonly attachments: Parameters<typeof providerMessageTextWithAttachmentPaths>[0]["attachments"];
  readonly attachmentsDir: string;
  readonly runtimeInstruction?: string | undefined;
}): string {
  const text = providerMessageTextWithAttachmentPaths({
    text: input.text,
    attachments: input.attachments,
    resolveAttachmentPath: (attachment) =>
      resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment }),
    preserveOverflow: true,
  });
  return input.runtimeInstruction === undefined
    ? text
    : text
      ? `${text}\n\n${input.runtimeInstruction}`
      : input.runtimeInstruction;
}

export class ProviderCurrentInputError extends Schema.TaggedError<ProviderCurrentInputError>()(
  "ProviderCurrentInputError",
  { inputChars: Schema.Number },
) {
  override get message(): string {
    return `The complete current request, including attached file paths and captured data, exceeds the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}-character provider input limit. Shorten the request or remove an attachment and retry.`;
  }
}

export function validateProviderCurrentInput(
  input: Parameters<typeof formatScientCurrentInput>[0],
): Result.Result<string, ProviderCurrentInputError> {
  const text = formatScientCurrentInput({
    ...input,
    text: expandComposerCitationsForProvider(input.text),
  });
  return text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ? Result.fail(new ProviderCurrentInputError({ inputChars: text.length }))
    : Result.succeed(text);
}
