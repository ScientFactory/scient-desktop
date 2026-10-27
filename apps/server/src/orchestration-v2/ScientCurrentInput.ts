import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { expandComposerCitationsForProvider } from "@t3tools/shared/composerCitations";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as DocumentText from "../provider/DocumentText.ts";

/** Complete current material; inherited history has its separate receiving budget. */
export const formatScientCurrentInput = Effect.fn("ScientCurrentInput.format")(function* (input: {
  readonly text: string;
  readonly attachments: Parameters<typeof providerMessageTextWithAttachmentPaths>[0]["attachments"];
  readonly attachmentsDir: string;
  readonly runtimeInstruction?: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* providerMessageTextWithAttachmentPaths({
    text: input.text,
    attachments: input.attachments,
    resolveAttachmentPath: (attachment) =>
      resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment }),
    resolveExtractedTextPath: (path) =>
      DocumentText.resolveExtractedTextPath(path).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    preserveOverflow: true,
  });
  return input.runtimeInstruction === undefined
    ? text
    : text
      ? `${text}\n\n${input.runtimeInstruction}`
      : input.runtimeInstruction;
});

export class ProviderCurrentInputError extends Schema.TaggedError<ProviderCurrentInputError>()(
  "ProviderCurrentInputError",
  { inputChars: Schema.Number },
) {
  override get message(): string {
    return `The complete current request, including attached file paths and captured data, exceeds the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}-character provider input limit. Shorten the request or remove an attachment and retry.`;
  }
}

export const validateProviderCurrentInput = Effect.fn("ScientCurrentInput.validate")(function* (
  input: Parameters<typeof formatScientCurrentInput>[0],
) {
  const text = yield* formatScientCurrentInput({
    ...input,
    text: expandComposerCitationsForProvider(input.text),
  });
  if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    return yield* new ProviderCurrentInputError({ inputChars: text.length });
  return text;
});
