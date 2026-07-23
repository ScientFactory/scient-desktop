// FILE: localVoiceModelManifest.ts
// Purpose: Pins the single supported offline multilingual Whisper model and its provenance.
// Layer: Desktop voice runtime

export interface LocalVoiceModelManifest {
  readonly id: string;
  readonly fileName: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly headerHex: "6c6d6767";
  readonly sourceRevision: string;
  readonly downloadUrl: string;
  readonly license: "MIT";
}

const SOURCE_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

export const LOCAL_VOICE_MODEL: LocalVoiceModelManifest = Object.freeze({
  id: "whisper-small-multilingual-q5_1",
  fileName: "ggml-small-q5_1-ae85e4a9.bin",
  displayName: "Multilingual Small",
  byteSize: 190_085_487,
  sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  // whisper.cpp GGML model magic: bytes 6c 6d 67 67 ("lmgg").
  headerHex: "6c6d6767",
  sourceRevision: SOURCE_REVISION,
  downloadUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${SOURCE_REVISION}/ggml-small-q5_1.bin?download=true`,
  license: "MIT",
});
