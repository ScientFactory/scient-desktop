import type { VoiceModelSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findVoiceReplacementModel, voiceModelProgressPercent } from "./VoiceSettingsPanel.tsx";

const small: VoiceModelSummary = {
  id: "whisper-small-multilingual-q5_1",
  displayName: "Multilingual Small",
  description: "Small",
  byteSize: 100,
  state: { state: "ready", byteSize: 100 },
};

const medium: VoiceModelSummary = {
  id: "whisper-medium-multilingual-q5_0",
  displayName: "Multilingual Medium",
  description: "Medium",
  byteSize: 200,
  state: { state: "missing" },
};

describe("VoiceSettingsPanel model state", () => {
  it("reports bounded download progress", () => {
    expect(
      voiceModelProgressPercent({
        ...medium,
        state: { state: "downloading", downloadedBytes: 25, totalBytes: 100 },
      }),
    ).toBe(25);
    expect(
      voiceModelProgressPercent({
        ...medium,
        state: { state: "downloading", downloadedBytes: 150, totalBytes: 100 },
      }),
    ).toBe(100);
    expect(voiceModelProgressPercent(medium)).toBe(0);
  });

  it("selects only another ready model as the removal fallback", () => {
    expect(findVoiceReplacementModel([small, medium], medium.id)?.id).toBe(small.id);
    expect(findVoiceReplacementModel([small, medium], small.id)).toBeNull();
  });
});
