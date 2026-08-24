import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_VOICE_MODEL_ID,
  getVoiceModelDefinition,
  GGML_MAGIC_HEADER_HEX,
  requireVoiceModelDefinition,
  VOICE_MODEL_DEFINITIONS,
} from "./modelManifest.ts";

describe("voice model manifest", () => {
  it("ships the pinned Small and Medium models with Small as the default", () => {
    expect(VOICE_MODEL_DEFINITIONS).toHaveLength(2);
    expect(DEFAULT_VOICE_MODEL_ID).toBe("whisper-small-multilingual-q5_1");
    expect(VOICE_MODEL_DEFINITIONS[0]?.id).toBe(DEFAULT_VOICE_MODEL_ID);
    expect(VOICE_MODEL_DEFINITIONS[1]?.id).toBe("whisper-medium-multilingual-q5_0");
  });

  it("pins the Multilingual Medium artifact", () => {
    const model = requireVoiceModelDefinition("whisper-medium-multilingual-q5_0");
    expect(model.fileName).toBe("ggml-medium-q5_0-19fea4b3.bin");
    expect(model.displayName).toBe("Multilingual Medium");
    expect(model.byteSize).toBe(539_212_467);
    expect(model.sha256).toBe("19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f");
    expect(model.sourceRevision).toBe("5359861c739e955e79d9a303bcbc70fb988958b1");
  });

  it("pins the verified provenance copied from upstream", () => {
    const model = requireVoiceModelDefinition(DEFAULT_VOICE_MODEL_ID);
    expect(model.fileName).toBe("ggml-small-q5_1-ae85e4a9.bin");
    expect(model.displayName).toBe("Multilingual Small");
    expect(model.byteSize).toBe(190_085_487);
    expect(model.sha256).toBe("ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb");
    expect(model.sourceRevision).toBe("5359861c739e955e79d9a303bcbc70fb988958b1");
    expect(model.license).toBe("MIT");
  });

  it("verifies with a 64-char sha256 and the GGML magic header", () => {
    const model = requireVoiceModelDefinition(DEFAULT_VOICE_MODEL_ID);
    expect(model.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(model.byteSize).toBeGreaterThan(0);
    expect(model.headerHex).toBe(GGML_MAGIC_HEADER_HEX);
    expect(GGML_MAGIC_HEADER_HEX).toBe("6c6d6767");
  });

  it("downloads from a revision-pinned whisper.cpp HuggingFace URL", () => {
    const model = requireVoiceModelDefinition(DEFAULT_VOICE_MODEL_ID);
    expect(model.downloadUrl).toContain("huggingface.co/ggerganov/whisper.cpp");
    expect(model.downloadUrl).toContain(model.sourceRevision);
  });

  it("resolves definitions by id and rejects unknown ids", () => {
    expect(getVoiceModelDefinition(DEFAULT_VOICE_MODEL_ID)?.id).toBe(DEFAULT_VOICE_MODEL_ID);
    expect(getVoiceModelDefinition("nope")).toBeUndefined();
    expect(() => requireVoiceModelDefinition("nope")).toThrow(/Unknown voice model id/u);
  });
});
