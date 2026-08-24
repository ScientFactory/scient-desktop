import {
  isProviderAvailable,
  VoiceTranscriptCorrectionError,
  type VoiceTranscriptCorrectionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderRegistryShape } from "../../provider/Services/ProviderRegistry.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";

export const VOICE_TRANSCRIPT_CORRECTION_TIMEOUT_MS = 12_000;

function failure(
  kind: VoiceTranscriptCorrectionError["kind"],
  message: string,
): VoiceTranscriptCorrectionError {
  return new VoiceTranscriptCorrectionError({ kind, message });
}

export function makeVoiceTranscriptCorrection(input: {
  readonly registry: ProviderRegistryShape;
  readonly serverSettings: ServerSettingsService["Service"];
  readonly timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? VOICE_TRANSCRIPT_CORRECTION_TIMEOUT_MS;

  return {
    correct: Effect.fn("VoiceTranscriptCorrection.correct")(function* (request: {
      readonly transcript: string;
    }): Effect.fn.Return<VoiceTranscriptCorrectionResult, VoiceTranscriptCorrectionError> {
      const settings = yield* input.serverSettings.getSettings.pipe(
        Effect.mapError(() =>
          failure("provider-unavailable", "The selected AI provider is unavailable."),
        ),
      );
      const modelSelection = settings.textGenerationModelSelection;
      const providers = yield* input.registry.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === modelSelection.instanceId,
      );
      const correction = yield* input.registry.getVoiceTranscriptCorrectionForInstance(
        modelSelection.instanceId,
      );

      if (!provider || !correction) {
        return yield* failure(
          "unsupported",
          "The selected AI provider does not support transcript correction.",
        );
      }
      if (!provider.enabled) {
        return yield* failure("provider-unavailable", "The selected AI provider is disabled.");
      }

      if (
        !isProviderAvailable(provider) ||
        !provider.installed ||
        provider.status === "disabled" ||
        provider.status === "error"
      ) {
        return yield* failure("provider-unavailable", "The selected AI provider is not ready.");
      }
      if (provider.auth.status !== "authenticated") {
        return yield* failure("authentication", "The selected AI provider is not signed in.");
      }

      const corrected = yield* correction
        .correct({ transcript: request.transcript, modelSelection })
        .pipe(Effect.timeoutOption(timeoutMs));
      if (Option.isNone(corrected)) {
        return yield* failure("timeout", "Transcript correction timed out.");
      }

      return {
        text: corrected.value.text,
        provider: provider.driver,
      };
    }),
  };
}
