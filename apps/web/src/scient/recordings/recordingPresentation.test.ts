import { expect, it } from "vite-plus/test";
import {
  captureElapsed,
  recordingTime,
  segmentDirection,
  transcriptParagraphs,
} from "./recordingPresentation";

it("resolves each caption from its strong script and uses language for neutral captions", () => {
  expect(segmentDirection("שלום עולם", "en")).toBe("rtl");
  expect(segmentDirection("مرحبا بالعالم", "auto")).toBe("rtl");
  expect(segmentDirection("An English quote", "he")).toBe("ltr");
  expect(segmentDirection("2026", "ar-EG")).toBe("rtl");
  expect(segmentDirection("אבג abcde", "en", "rtl")).toBe("rtl");
  expect(segmentDirection("שלום", "he", undefined, "ltr")).toBe("ltr");
});

it("preserves hours and the minute offset in a long recording", () => {
  expect(recordingTime(3724)).toBe("1:02:04");
});

it("groups connected cues by speaker, silence and direction while retaining source indexes", () => {
  const result = transcriptParagraphs(
    [
      { text: "ANA BELL: The Creative", start: 0, end: 2 },
      { text: "Commons license.", start: 2, end: 4 },
      { text: "שלום לכולם", start: 4, end: 7 },
      { text: "תודה", start: 9, end: 11 },
    ],
    ["ltr", "ltr", "rtl", "rtl"],
    false,
  );
  expect(result.rows).toEqual([0, 0, 1, 2]);
  expect(result.paragraphs[0]).toMatchObject({
    speaker: "ANA BELL",
    text: "The Creative Commons license.",
  });
});

it("excludes time spent paused from the microphone timer", () => {
  const clock = { started: 100, elapsed: 0 };
  const paused = captureElapsed(clock, 2_100);
  expect(captureElapsed({ started: undefined, elapsed: paused }, 16_000)).toBe(2_000);
  expect(captureElapsed({ started: 16_000, elapsed: paused }, 17_000)).toBe(3_000);
});
