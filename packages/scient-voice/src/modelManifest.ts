// Pinned offline Whisper model registry.
//
// Structured as an id-keyed registry so adding a `base`/`medium`/etc. model is
// just another array element. Exactly ONE entry ships today: the multilingual
// Small Q5_1 model. The id, filename, byte size, sha256, source revision, and
// download URL are copied verbatim from the old app's manifest so a download
// actually verifies against upstream.

/** GGML model magic as stored on disk (whisper.cpp writes it little-endian). */
// The 32-bit GGML magic is 0x67676d6c ("ggml"); serialized little-endian the
// first four bytes on disk are 0x6c 0x6d 0x67 0x67 ("lmgg").
export const GGML_MAGIC_HEADER_HEX = "6c6d6767";

export interface VoiceModelDefinition {
  readonly id: string;
  readonly fileName: string;
  readonly displayName: string;
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
  byteSize: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  headerHex: GGML_MAGIC_HEADER_HEX,
  sourceRevision: WHISPER_CPP_REVISION,
  downloadUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_CPP_REVISION}/ggml-small-q5_1.bin?download=true`,
  license: "MIT",
});

/** Default model id used when a caller does not specify one. */
export const DEFAULT_VOICE_MODEL_ID = WHISPER_SMALL_MULTILINGUAL_Q5_1.id;

/** Every supported model, in preference order. Ships one entry today. */
export const VOICE_MODEL_DEFINITIONS: readonly VoiceModelDefinition[] = Object.freeze([
  WHISPER_SMALL_MULTILINGUAL_Q5_1,
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
