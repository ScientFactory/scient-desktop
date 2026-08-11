import { describe, expect, it } from "vite-plus/test";

import { applyVoiceTranscript, buildVoiceDraftReplacement } from "./voiceComposerInsert.ts";

describe("buildVoiceDraftReplacement", () => {
  it("replaces an empty draft with the trimmed transcript", () => {
    expect(buildVoiceDraftReplacement("", "  dictated text  ")).toEqual({
      rangeStart: 0,
      rangeEnd: 0,
      replacement: "dictated text",
    });
  });

  it("appends dictation to the current visible draft as a new line", () => {
    expect(buildVoiceDraftReplacement("Existing draft", "dictated text")).toEqual({
      rangeStart: 0,
      rangeEnd: 14,
      replacement: "Existing draft\ndictated text",
    });
  });

  it("uses the draft current at transcription completion", () => {
    expect(buildVoiceDraftReplacement("Edited while recording", "dictated text")).toEqual({
      rangeStart: 0,
      rangeEnd: 22,
      replacement: "Edited while recording\ndictated text",
    });
  });

  it("commits through one authoritative replacement callback with the caret at the end", () => {
    const currentDraft = "Existing draft";
    let committedText = "";
    let committedCursor = -1;

    const applied = applyVoiceTranscript(
      currentDraft,
      "dictated text",
      (rangeStart, rangeEnd, replacement) => {
        committedText = `${currentDraft.slice(0, rangeStart)}${replacement}${currentDraft.slice(rangeEnd)}`;
        committedCursor = rangeStart + replacement.length;
        return true;
      },
    );

    expect(applied).toBe(true);
    expect(committedText).toBe("Existing draft\ndictated text");
    expect(committedCursor).toBe(committedText.length);
  });
});
