import { describe, expect, it } from "vite-plus/test";

import {
  EXPECTED_PHRASE,
  normalizeTranscript,
  QUALIFICATION_MODEL,
  QUALIFICATION_RECORDING,
} from "./qualify-whisper-runtime.mjs";
import { WHISPER_CPP_COMMIT } from "./stage-whisper-runtime.ts";

describe("qualify-whisper-runtime", () => {
  it("pins the model and the recording", () => {
    expect(QUALIFICATION_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.url).toContain(WHISPER_CPP_COMMIT);
  });

  it("compares words, not punctuation or case", () => {
    expect(
      normalizeTranscript(
        " And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
      ),
    ).toContain(EXPECTED_PHRASE);
    expect(normalizeTranscript("Ask not!\n  What your-country")).toBe("ask not what your country");
  });
});
