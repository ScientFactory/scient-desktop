// SCIENT-OWNED: T3's voice transcript cleanup is dormant in Scient. Scient's own providers
// report it unsupported until the voice decision; Scient's correction runs in this folder.
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const transcriptionCleanupUnsupported = (provider: string) =>
  Effect.fail(
    new TextGenerationError({
      operation: "generateTranscriptionPostProcessing",
      detail: `${provider} does not clean up voice transcripts.`,
    }),
  );
