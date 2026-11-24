import { recordingSpeechModelIds } from "@t3tools/shared/speech";
import * as Schema from "effect/Schema";
import { SPEECH_MODELS } from "../speech/model.ts";

const ivritTurbo = {
  id: "vladkens/ivrit-whisper-large-v3-turbo-gguf",
  name: "ivrit.ai Whisper Large v3 Turbo",
  revision: "5d15b8bc0cf961639ac3d3647157514a24eb0084",
  filename: "ivrit-whisper-large-v3-turbo-Q8_0.gguf",
  size: 886381920,
  sha256: "da1f765ce2cfc495459fb3cc5deb2aaa2fa741eec79bff259b3da0481c4533ac",
  languages: ["he"],
  supportsLanguageDetection: false,
  benchmark: {
    accuracy: { he: { grade: "D", errorPercent: 20.6 } },
    secondsPer30s: { accelerated: null },
  },
};
export const transcriptionModels = [
  ivritTurbo,
  ...SPEECH_MODELS.filter((model) => model.id !== ivritTurbo.id),
];
export const getTranscriptionModel = (id: string) =>
  transcriptionModels.find((model) => model.id === id);

export const arabicAlternative = "handy-computer/cohere-transcribe-arabic-07-2026-gguf";
export const englishFast = "handy-computer/parakeet-tdt-0.6b-v3-gguf";

export const supportsLanguage = (model: (typeof transcriptionModels)[number], language: string) =>
  language === "auto"
    ? model.supportsLanguageDetection && model.languages.length > 1
    : model.languages.includes(language) || model.languages.includes(language.split("-")[0]!);

export function modelCandidates(language: string) {
  return recordingSpeechModelIds(language).flatMap((id) => {
    const model = getTranscriptionModel(id);
    return model && supportsLanguage(model, language) ? [model] : [];
  });
}

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.Finite,
  installed: Schema.Boolean,
  grade: Schema.optionalKey(Schema.String),
  secondsPer30s: Schema.Struct({
    accelerated: Schema.NullOr(Schema.Finite),
    cpu: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
  languages: Schema.optionalKey(Schema.Array(Schema.String)),
  accuracy: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        grade: Schema.String,
        errorPercent: Schema.Finite,
      }),
    ),
  ),
});

const Choice = Schema.Struct({
  id: Schema.String,
  installed: Schema.Boolean,
  role: Schema.optionalKey(
    Schema.Literals(["recommended", "faster", "more-accurate", "alternative"]),
  ),
});

export const InventoryInput = Schema.Struct({
  language: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Boolean),
});

export const EngineInventory = Schema.Struct({
  mediaAvailable: Schema.Boolean,
  local: Schema.Array(Model),
  chatgpt: Schema.Struct({
    model: Schema.Literal("chatgpt"),
    enabled: Schema.Boolean,
    signedIn: Schema.NullOr(Schema.Boolean),
  }),
  agentsMayUseCloudEngines: Schema.Boolean,
  cloud: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      model: Schema.String,
      accountName: Schema.optionalKey(Schema.String),
      origin: Schema.optionalKey(Schema.String),
      audioHourUsd: Schema.optionalKey(Schema.Finite),
    }),
  ),
  recommendations: Schema.Record(Schema.String, Choice),
});

// https://platform.openai.com/pricing/ and https://docs.x.ai/developers/models/speech-to-text
export function audioTranscriptionHourUsd(provider: string, model: string): number | undefined {
  if (provider === "openai") {
    switch (model) {
      case "gpt-transcribe":
        return 0.27;
      case "gpt-4o-transcribe":
        return 0.36;
      case "gpt-4o-mini-transcribe":
        return 0.18;
    }
  }
  if (provider === "xai" && model === "grok-voice-transcribe-2.0") return 0.1;
  return undefined;
}
