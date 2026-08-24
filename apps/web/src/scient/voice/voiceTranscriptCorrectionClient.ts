import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  type VoiceTranscriptionLanguage,
  type VoiceTranscriptCorrectionResult,
  WS_METHODS,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime.ts";

export interface VoiceTranscriptCorrectionClient {
  readonly correct: (input: {
    readonly environmentId: EnvironmentId;
    readonly transcript: string;
    readonly language?: VoiceTranscriptionLanguage;
    readonly signal: AbortSignal;
  }) => Promise<VoiceTranscriptCorrectionResult>;
}

export type VoiceTranscriptCorrectionOutcome =
  | { readonly kind: "disabled"; readonly text: string }
  | { readonly kind: "corrected"; readonly text: string; readonly provider: ProviderDriverKind }
  | { readonly kind: "fallback"; readonly text: string };

export const voiceTranscriptCorrectionCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:correct-transcript",
  tag: WS_METHODS.voiceCorrectTranscript,
  concurrency: { mode: "parallel" },
});

export function makeVoiceTranscriptCorrectionClient<E>(
  run: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly transcript: string;
      readonly language?: VoiceTranscriptionLanguage;
    };
  }) => Promise<AtomCommandResult<VoiceTranscriptCorrectionResult, E>>,
): VoiceTranscriptCorrectionClient {
  return {
    correct: async ({ environmentId, transcript, language, signal }) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await new Promise<AtomCommandResult<VoiceTranscriptCorrectionResult, E>>(
        (resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
          void run({
            environmentId,
            input: { transcript, ...(language ? { language } : {}) },
          })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
        },
      );
      if (result._tag === "Failure") throw new Error("Transcript correction failed.");
      return result.value;
    },
  };
}

/** Correction is deliberately fail-open: the local transcript always remains usable. */
export async function correctVoiceTranscript(input: {
  readonly enabled: boolean;
  readonly client: VoiceTranscriptCorrectionClient | null;
  readonly environmentId: EnvironmentId | undefined;
  readonly transcript: string;
  readonly language?: VoiceTranscriptionLanguage;
  readonly signal: AbortSignal;
}): Promise<VoiceTranscriptCorrectionOutcome> {
  if (!input.enabled || !input.client || !input.environmentId) {
    return { kind: "disabled", text: input.transcript };
  }

  try {
    const result = await input.client.correct({
      environmentId: input.environmentId,
      transcript: input.transcript,
      ...(input.language ? { language: input.language } : {}),
      signal: input.signal,
    });
    const text = result.text.trim();
    return text
      ? { kind: "corrected", text, provider: result.provider }
      : { kind: "fallback", text: input.transcript };
  } catch {
    return { kind: "fallback", text: input.transcript };
  }
}
