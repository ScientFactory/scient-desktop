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

  it("appends dictation to the current visible draft without forcing a new line", () => {
    expect(buildVoiceDraftReplacement("Existing draft", "dictated text")).toEqual({
      rangeStart: 0,
      rangeEnd: 14,
      replacement: "Existing draft dictated text",
    });
  });

  it.each(["Existing draft ", "Existing draft\n", "Existing draft\n\n", "  "])(
    "preserves intentional trailing whitespace in %j",
    (draft) => {
      expect(buildVoiceDraftReplacement(draft, "more").replacement).toBe(`${draft}more`);
    },
  );

  it("preserves transcript paragraphs and leaves an empty transcript unchanged", () => {
    expect(buildVoiceDraftReplacement("שלום", "עולם\n\nNext paragraph").replacement).toBe(
      "שלום עולם\n\nNext paragraph",
    );
    expect(buildVoiceDraftReplacement("Keep me\n\n", "  ").replacement).toBe("Keep me\n\n");
  });

  it("uses the draft current at transcription completion", () => {
    expect(buildVoiceDraftReplacement("Edited while recording", "dictated text")).toEqual({
      rangeStart: 0,
      rangeEnd: 22,
      replacement: "Edited while recording dictated text",
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
    expect(committedText).toBe("Existing draft dictated text");
    expect(committedCursor).toBe(committedText.length);
  });
});
