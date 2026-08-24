// Pinned offline Whisper model registry.
//
// Structured as an id-keyed registry so adding another model is just another
// array element. The artifact metadata is pinned so downloads are always
// verified against the exact upstream files we ship support for.

/** GGML model magic as stored on disk (whisper.cpp writes it little-endian). */
// The 32-bit GGML magic is 0x67676d6c ("ggml"); serialized little-endian the
// first four bytes on disk are 0x6c 0x6d 0x67 0x67 ("lmgg").
export const GGML_MAGIC_HEADER_HEX = "6c6d6767";

export interface VoiceModelDefinition {
  readonly id: string;
  readonly fileName: string;
  readonly displayName: string;
  readonly description: string;
  readonly byteSize: number;
  readonly sha256: string;
  /** Expected leading bytes, hex-encoded. See {@link GGML_MAGIC_HEADER_HEX}. */
  readonly headerHex: string;
  readonly sourceRevision: string;
  readonly downloadUrl: string;
  readonly license: string;
}

const WHISPER_CPP_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

const WHISPER_SMALL_MULTILINGUAL_Q5_1: VoiceModelDefinition = Object.freeze({
  id: "whisper-small-multilingual-q5_1",
  fileName: "ggml-small-q5_1-ae85e4a9.bin",
  displayName: "Multilingual Small",
  description: "Fast and light for everyday dictation.",
  byteSize: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  headerHex: GGML_MAGIC_HEADER_HEX,
  sourceRevision: WHISPER_CPP_REVISION,
  downloadUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_REVISION}/ggml-small-q5_1.bin?download=true`,
  license: "MIT",
});

const WHISPER_MEDIUM_MULTILINGUAL_Q5_0: VoiceModelDefinition = Object.freeze({
  id: "whisper-medium-multilingual-q5_0",
  fileName: "ggml-medium-q5_0-19fea4b3.bin",
  displayName: "Multilingual Medium",
  description: "Higher accuracy on more capable computers.",
  byteSize: 539_212_467,
  sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  headerHex: GGML_MAGIC_HEADER_HEX,
  sourceRevision: WHISPER_CPP_REVISION,
  downloadUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_REVISION}/ggml-medium-q5_0.bin?download=true`,
  license: "MIT",
});

const WHISPER_LARGE_V3_TURBO_MULTILINGUAL_Q5_0: VoiceModelDefinition = Object.freeze({
  id: "whisper-large-v3-turbo-multilingual-q5_0",
  fileName: "ggml-large-v3-turbo-q5_0-39422170.bin",
  displayName: "Multilingual Turbo",
  description: "Most capable for demanding dictation on powerful computers.",
  byteSize: 574_041_195,
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  headerHex: GGML_MAGIC_HEADER_HEX,
  sourceRevision: WHISPER_CPP_REVISION,
  downloadUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_REVISION}/ggml-large-v3-turbo-q5_0.bin?download=true`,
  license: "MIT",
});

export const SMALL_VOICE_MODEL_ID = WHISPER_SMALL_MULTILINGUAL_Q5_1.id;
export const MEDIUM_VOICE_MODEL_ID = WHISPER_MEDIUM_MULTILINGUAL_Q5_0.id;
export const TURBO_VOICE_MODEL_ID = WHISPER_LARGE_V3_TURBO_MULTILINGUAL_Q5_0.id;

/** Small is the safe migration fallback for existing installations. */
export const DEFAULT_VOICE_MODEL_ID = SMALL_VOICE_MODEL_ID;

/** Every supported model, in preference order. */
export const VOICE_MODEL_DEFINITIONS: readonly VoiceModelDefinition[] = Object.freeze([
  WHISPER_SMALL_MULTILINGUAL_Q5_1,
  WHISPER_MEDIUM_MULTILINGUAL_Q5_0,
  WHISPER_LARGE_V3_TURBO_MULTILINGUAL_Q5_0,
]);

const VOICE_MODELS_BY_ID: ReadonlyMap<string, VoiceModelDefinition> = new Map(
  VOICE_MODEL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/** Look up a model definition by id, or `undefined` when unknown. */
export function getVoiceModelDefinition(id: string): VoiceModelDefinition | undefined {
  return VOICE_MODELS_BY_ID.get(id);
}

/** Look up a model definition by id, throwing when unknown. */
export function requireVoiceModelDefinition(id: string): VoiceModelDefinition {
  const definition = VOICE_MODELS_BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown voice model id: ${id}`);
  }
  return definition;
}
