// @effect-diagnostics nodeBuiltinImport:off - Fixture reads are synchronous in pure parser tests.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import {
  parseAss,
  parseSrt,
  parseTeamsDocument,
  parseVtt,
  parseZoomVtt,
} from "./subtitleParsers.ts";
import { alignSubtitles, assessSubtitles } from "./subtitleQuality.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL("./fixtures/subtitles/" + name, import.meta.url), "utf8");

it.each([
  [parseSrt, "he.srt", "שלום, العالم", null],
  [parseVtt, "teams.vtt", "שלום & مرحبا", "ליאורה"],
  [parseZoomVtt, "zoom.vtt", "مرحبا بالعالم", "ليلى"],
  [parseAss, "styled.ass", "שלום, العالم\nNext", "ليلى"],
] as const)("preserves text and attribution in %s (%s)", (parse, file, text, speaker) => {
  const input = fixture(file);
  expect(parse(file === "he.srt" ? input.replace(/\r?\n/g, "\r\n") : input)).toEqual([
    { start: 1, end: 2.5, text, speaker },
  ]);
});

it("uses the next Teams DOCX timestamp to close a speaker turn", () => {
  expect(parseTeamsDocument(fixture("teams.xml"), 6)).toEqual([
    { start: 1, end: 3, speaker: "ליאורה", text: "שלום & مرحبا" },
    { start: 3, end: 6, speaker: "ليلى", text: "مرحبا" },
  ]);
});

it("recovers a global offset and film-to-PAL scale", () => {
  const speech = [10, 27, 49, 118, 250, 404, 619].map((start) => ({ start, end: start + 2 }));
  const cues = speech.map(({ start, end }) => ({
    start: ((start - 3) * 25) / 24,
    end: ((end - 3) * 25) / 24,
    text: "speech",
    speaker: null,
  }));
  const aligned = alignSubtitles(speech, cues);
  expect(aligned.correction.offset).toBeCloseTo(3);
  expect(aligned.correction.scale).toBeCloseTo(24 / 25);
  expect(aligned.coverage).toBeCloseTo(1);
});

it("recommends the three choices using language, coverage, and agreement", () => {
  const samples = Array.from({ length: 3 }, () => ({
    subtitle: "Hello world ".repeat(25),
    recognized: [{ text: "hello world ".repeat(25), language: "en" }],
  }));
  expect(
    assessSubtitles({ invalidCues: 0, coverage: 0.9 }, "eng", false, samples).recommendation,
  ).toBe("use-subtitles");
  expect(
    assessSubtitles({ invalidCues: 0, coverage: 0.6 }, "eng", false, samples).recommendation,
  ).toBe("both");
  expect(
    assessSubtitles({ invalidCues: 0, coverage: 0.9 }, "heb", false, samples).recommendation,
  ).toBe("transcribe-only");
  expect(
    assessSubtitles({ invalidCues: 0, coverage: 0.9 }, "eng", true, samples).recommendation,
  ).toBe("transcribe-only");
  const different = samples.map((sample) => ({ ...sample, subtitle: "different words entirely" }));
  expect(
    assessSubtitles({ invalidCues: 0, coverage: 0.9 }, "eng", false, different).recommendation,
  ).toBe("transcribe-only");
});

it("preserves a synced dense recording and recovers a 45-second intro", () => {
  const dense = [
    { start: 50, end: 1800 },
    { start: 1805, end: 3550 },
  ];
  const cue = (start: number, end: number) => ({ start, end, text: "speech", speaker: null });
  expect(
    alignSubtitles(
      dense,
      dense.map(({ start, end }) => cue(start, end)),
    ).correction,
  ).toEqual({ offset: 0, scale: 1 });
  const speech = [51, 63, 94, 109, 154, 199, 221].map((start) => ({ start, end: start + 3 }));
  expect(
    alignSubtitles(
      speech,
      speech.map(({ start, end }) => cue(start - 45, end - 45)),
    ).correction,
  ).toEqual({ offset: 45, scale: 1 });
});

it("preserves comparisons and attributes multiple VTT voices after a NOTE", () => {
  const vtt =
    "WEBVTT\n\n\nNOTE do not import\n00:01.000 --> 00:02.000\nignore\n\n\n00:03.000 --> 00:04.000\n<v Ada>x < 5 and y > 3</v> <v Sam>&AMP; &#X41;</v>";
  expect(parseVtt(vtt)).toEqual([
    { start: 3, end: 4, text: "x < 5 and y > 3", speaker: "Ada" },
    { start: 3, end: 4, text: "& A", speaker: "Sam" },
  ]);
});

it("ignores empty XML elements and preserves breaks when Teams duration is unknown", () => {
  const xml =
    "<w:p/><w:p><w:t>ליאורה \u200f0:01</w:t></w:p><w:p><w:t/><w:t>Meet at 12:30</w:t><w:br/><w:t>שלום</w:t></w:p>";
  expect(parseTeamsDocument(xml, NaN)).toEqual([
    { start: 1, end: 4, text: "Meet at 12:30\nשלום", speaker: "ליאורה" },
  ]);
});

it("normalizes vocalization and estimates language from untagged samples", () => {
  const samples = [
    {
      subtitle: "[MUSIC] " + "שָׁלוֹם עוֹלָם ".repeat(75),
      recognized: [{ text: "שלום עולם ".repeat(75) }],
    },
  ];
  const report = assessSubtitles(
    { invalidCues: 0, emptyCues: 1, totalCues: 100, coverage: 0.95 },
    undefined,
    false,
    samples,
    { model: "ivrit" },
  );
  expect(report).toMatchObject({
    languageMatch: true,
    wordErrorRate: 0,
    evaluatedWords: 150,
    recommendation: "use-subtitles",
  });
});

it("flags thirds with incompatible timing after a mid-recording cut", () => {
  const speech = [7, 19, 47, 85, 104, 113, 148, 171, 193, 205, 249, 287].map((start) => ({
    start,
    end: start + 4,
  }));
  const cues = speech.map(({ start, end }, index) => {
    const shift = index < 7 ? 0 : 33;
    return { start: start + shift, end: end + shift, text: "spoken", speaker: null };
  });
  expect(alignSubtitles(speech, cues)).toMatchObject({
    correction: { scale: 1 },
    nonLinearDrift: true,
  });
});

it("parses a Teams header and its body separated by paragraph line breaks", () => {
  const xml =
    "<w:p><w:t>Alice 0:01</w:t><w:br/><w:t>Hello world</w:t><w:br/><w:t>More speech</w:t></w:p>";
  expect(parseTeamsDocument(xml, 4)).toEqual([
    { start: 1, end: 4, speaker: "Alice", text: "Hello world\nMore speech" },
  ]);
});

it("keeps Zoom colon prose and extracts RTL names without detached controls", () => {
  const zoom =
    "WEBVTT\n\n00:01.000 --> 00:02.000\nNote: ready\n\n00:02.000 --> 00:03.000\n\u2067ليلى:\u2069 مرحبا\n\n00:03.000 --> 00:04.000\nhttps://example.org";
  expect(parseZoomVtt(zoom).map(({ speaker, text }) => [speaker, text])).toEqual([
    [null, "Note: ready"],
    ["ليلى", "مرحبا"],
    [null, "https://example.org"],
  ]);
});
