import { VoiceTranscriptCorrectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderVoiceTranscriptCorrection } from "../../provider/ProviderDriver.ts";
import type { AntigravityStructuredGeneration } from "../../textGeneration/AntigravityTextGeneration.ts";
import {
  buildVoiceTranscriptCorrectionPrompt,
  validateVoiceTranscriptCorrectionOutput,
  VoiceTranscriptCorrectionOutput,
} from "./VoiceTranscriptCorrectionPrompt.ts";

const isVoiceTranscriptCorrectionError = Schema.is(VoiceTranscriptCorrectionError);

const providerFailure = () =>
  new VoiceTranscriptCorrectionError({
    kind: "provider-error",
    message: "Antigravity transcript correction failed.",
  });

/**
 * Reuse the official ACP structured-generation sandbox for transcript cleanup.
 * This preserves Scient's voice capability without reviving a second `agy`
 * process path for otherwise-native ACP accounts.
 */
export function makeAntigravityAcpVoiceTranscriptCorrection(
  generateStructured: AntigravityStructuredGeneration,
): ProviderVoiceTranscriptCorrection {
  return {
    correct: (input) =>
      generateStructured({
        operation: "correctVoiceTranscript",
        prompt: buildVoiceTranscriptCorrectionPrompt(input.transcript, input.language),
        outputSchema: VoiceTranscriptCorrectionOutput,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.flatMap((output) =>
          validateVoiceTranscriptCorrectionOutput({
            transcript: input.transcript,
            output,
          }),
        ),
        Effect.mapError((cause) =>
          isVoiceTranscriptCorrectionError(cause) ? cause : providerFailure(),
        ),
      ),
  };
}
