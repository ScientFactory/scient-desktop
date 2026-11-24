import { expect, it } from "vite-plus/test";
import { formatTranscript } from "./transcriptExport";

it("preserves long Hebrew and Arabic transcripts beyond 24 hours in all four formats", () => {
  const cues = Array.from({ length: 1080 }, (_, index) => ({
    start: index * 90,
    end: index * 90 + 3,
    text: "שלום לכולם · مرحبًا بالجميع",
    speaker: "דנה",
  }));
  const srt = formatTranscript(cues, "srt");
  expect(srt).toContain("1080\n26:58:30,000 --> 26:58:33,000\nדנה: שלום לכולם · مرحبًا بالجميع");
  const vtt = formatTranscript(cues, "vtt");
  expect(vtt).toMatch(/^WEBVTT\n\n/);
  expect(vtt).toContain("26:58:30.000 --> 26:58:33.000");
  expect(formatTranscript(cues, "md")).toContain("[26:58:30] דנה: שלום לכולם");
  expect(formatTranscript(cues, "txt").split("\n\n")).toHaveLength(1080);
});

it("preserves subtitle block boundaries when a cue contains blank lines or markup characters", () => {
  const cue = { start: 0, end: 1, text: "A & B\n\nUse <text> here." };
  expect(formatTranscript([cue], "vtt")).toBe(
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nA &amp; B\nUse &lt;text&gt; here.\n",
  );
});
