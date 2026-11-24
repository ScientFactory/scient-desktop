import { expect, it } from "@effect/vitest";
import { correctSegments, estimateCorrection } from "./correction.ts";
import type { Segment } from "./ledger.ts";
import { claimRelistenSpan } from "./relisten.ts";
import { mergeWords, recognitionTerms } from "./words.ts";

const raw: Segment = {
  id: "0-0",
  start: 2,
  end: 6,
  text: "Maya will not pay 50.",
  textRaw: " Maya will not pay 50.",
  language: "en",
  speaker: null,
  windowId: 0,
  engine: "local",
  model: "test",
  confidence: 0.4,
};
const signal = new AbortController().signal;

it.each([{ id: "0-1" }, { start: 3 }, { end: 7 }])(
  "rejects a window with changed alignment %j",
  async (change) => {
    const result = await correctSegments([raw], {
      mode: "quick",
      words: [],
      signal,
      generate: async () =>
        JSON.stringify({
          segments: [{ ...raw, text: "Changed text", uncertain: false, ...change }],
          suggestions: [],
        }),
    });
    expect(result.segments[0]).toMatchObject(raw);
    expect(result.reviewItems).toEqual([]);
    expect(result.rejectedWindows).toBe(1);
  },
);

it.each([
  "Mia will not pay 50.",
  "Maya will pay 50.",
  "Maya will not pay 15.",
  "Maya will not pay 5^0.",
])("keeps potentially consequential changes for review: %s", async (after) => {
  const result = await correctSegments([raw], {
    mode: "quick",
    words: [],
    signal,
    generate: async () =>
      JSON.stringify({ segments: [{ ...raw, text: after, uncertain: false }], suggestions: [] }),
  });
  expect(result.reviewItems).toEqual([
    expect.objectContaining({ segmentId: raw.id, before: raw.text, after }),
  ]);
  expect(result.segments[0]).toMatchObject({
    text: raw.text,
    textRaw: raw.textRaw,
    needsReview: true,
  });
});

it("ranks contextual words, filters languages, and bounds the merged snapshot", () => {
  const word = (term: string, preferred = term, language = "en") => ({
    term,
    preferred,
    language,
    source: "user" as const,
  });
  const global = Array.from({ length: 45 }, (_, index) => word("Global " + index));
  const words = mergeWords(
    [
      [...global, word("Cat", "Cat"), word("Relevant"), word("Cat", "Chat", "fr")],
      [word("Cat", "Project cat")],
      [word("cat", "Recording cat")],
    ],
    "en-US",
    "Relevant",
  );
  expect(words).toHaveLength(32);
  expect(words.slice(0, 2).map(({ preferred }) => preferred)).toEqual([
    "Relevant",
    "Recording cat",
  ]);
});

it("bounds combined recognition hints and keeps the ranked preferred spelling", () => {
  const words = [
    { term: "oh really", preferred: "O’Reilly", language: "und", source: "user" as const },
  ];
  const fallback = ["O’REILLY", ...Array.from({ length: 25 }, (_, index) => "Hint " + index)];
  const hints = recognitionTerms(words, fallback);
  expect(hints).toEqual(["O’Reilly", ...fallback.slice(1, 16)]);
});

it("admits only spans within the preflight audio allowance", () => {
  expect(claimRelistenSpan(raw, 4)).toBe(4);
  expect(claimRelistenSpan(raw, 3.99)).toBeUndefined();
  expect(claimRelistenSpan({ ...raw, end: 32 }, 100)).toBeUndefined();
});

it.each([
  ["we test the algoritm", "we test the algorithm", true],
  ["שלום לחברימ", "שלום לחברים", true],
  ["نبحث في الخوارزميه", "نبحث في الخوارزمية", true],
  ["שלום לחברימ", "שלום friends", false],
  ["نبحث في الخوارزميه", "نبحث في algorithm", false],
  ["دفعت ٥٠", "دفعت ٥١", false],
  ["نختار ۱۲", "نختار ۱۳", false],
  ["هذا صحيح", "ليس صحيح", false],
  ["זה נכון", "לא נכון", false],
  ["we paid fifty", "we paid forty", false],
  ["status x+2", "status x-2", false],
  ["choose left right", "choose right left", false],
])("gates automatic edits by content and script: %s", async (before, after, applies) => {
  const result = await correctSegments([{ ...raw, text: before, textRaw: before }], {
    mode: "quick",
    words: [],
    signal,
    generate: async () =>
      JSON.stringify({
        segments: [{ ...raw, start: raw.start + 0.001, text: after, uncertain: false }],
        suggestions: [],
      }),
  });
  expect(result.segments[0]).toMatchObject({
    text: applies ? after : before,
    textRaw: before,
    start: raw.start,
  });
  expect(result.appliedEdits).toHaveLength(applies ? 1 : 0);
  expect(result.reviewItems).toHaveLength(applies ? 0 : 1);
});

it("keeps Thorough selective and can corroborate an uncertain repair", async () => {
  const clear = { ...raw, id: "clear", confidence: 0.99, text: "Clear unrelated content." };
  const segments = [clear, { ...raw, text: "we test the algoritm" }];
  const estimate = estimateCorrection(
    "thorough",
    [],
    true,
    { audioSeconds: 8, wallSeconds: 10 },
    segments,
    0,
  );
  expect(estimate).toMatchObject({
    segments: 2,
    targetedSpans: 1,
    maxCalls: 2,
    relistenSeconds: 4,
    wallSeconds: 100,
  });
  expect(estimate.inputTokens).toBeGreaterThan(0);
  let relistened = 0;
  const result = await correctSegments(segments, {
    mode: "thorough",
    words: [],
    signal,
    maxCalls: estimate.maxCalls,
    generate: async (prompt) => {
      const { targets } = JSON.parse(prompt.slice(prompt.indexOf('{"targets"')));
      expect(targets.map(({ id }: Segment) => id)).toEqual([raw.id]);
      expect(prompt).toContain(clear.text);
      return JSON.stringify({
        segments: [{ ...raw, text: "we test the algorithm", uncertain: true }],
        suggestions: [],
      });
    },
    relisten: async () => {
      relistened++;
      return "we test the algorithm";
    },
  });
  expect(relistened).toBe(1);
  expect(result.segments[0]).toEqual(clear);
  expect(result.appliedEdits).toHaveLength(1);
});

it("reports unavailable and unsupported text generation as skipped", async () => {
  const options = { mode: "quick" as const, words: [], signal };
  const absent = await correctSegments([raw], options);
  expect(absent.correctionOutcome).toMatchObject({
    status: "skipped",
    reason: "model-not-configured",
  });
  const unsupported = await correctSegments([raw], {
    ...options,
    unavailable: "model-unsupported",
  });
  expect(unsupported.correctionOutcome).toMatchObject({
    status: "skipped",
    reason: "model-unsupported",
  });
  const failed = await correctSegments([raw], {
    ...options,
    generate: async () => {
      throw new Error("Unavailable");
    },
  });
  expect(failed.correctionOutcome).toMatchObject({
    status: "skipped",
    reason: "model-unavailable",
  });
});

it("uses explicit glossary spellings and respects model-flagged names", async () => {
  const before = "use py torch here";
  const words = [
    { term: "py torch", preferred: "Py Torch", language: "en", source: "user" as const },
  ];
  const result = await correctSegments([{ ...raw, text: before, confidence: 0.99 }], {
    mode: "thorough",
    words,
    signal,
    generate: async () =>
      JSON.stringify({ segments: [{ ...raw, text: before, uncertain: false }], suggestions: [] }),
  });
  expect(result.appliedEdits).toHaveLength(1);
  expect(result.segments[0]?.text).toBe("use Py Torch here");
  const guarded = await correctSegments([{ ...raw, text: "שלום לחברימ" }], {
    mode: "thorough",
    words: [],
    signal,
    generate: async () =>
      JSON.stringify({
        segments: [{ ...raw, text: "שלום לחברים", uncertain: false, protected: true }],
        suggestions: [],
      }),
    relisten: async () => "שלום לחברים",
  });
  expect(guarded.appliedEdits).toEqual([]);
  expect(guarded.reviewItems).toHaveLength(1);
});

it.each([
  ["helped me get through my", "helped me get through my."],
  ["you are coming.", "you are coming?"],
  ["we went home then slept", "we went home. then slept"],
  ["سوف يأتي", "سوف يأتي؟"],
  ["זה יקרה…", "זה יקרה"],
  ["אמר שלא יבוא מחר", "אמר שכן יבוא מחר"],
  ["قال ولن يأتي", "قال ومن يأتي"],
  ["זה אי אפשר", "זה כן אפשר"],
  ["הגיעו ושלוש נשארו", "הגיעו וארבע נשארו"],
  ["قل والثلاثة حضروا", "قل والأربعة حضروا"],
  ["turn left here", "turn right here"],
  ["take the first path", "take the third path"],
])("requires review even with corroboration for %s", async (before, after) => {
  const result = await correctSegments([{ ...raw, text: before }], {
    mode: "thorough",
    words: [],
    signal,
    generate: async () =>
      JSON.stringify({ segments: [{ ...raw, text: after, uncertain: false }], suggestions: [] }),
    relisten: async () => after,
  });
  expect(result.appliedEdits).toEqual([]);
  expect(result.reviewItems).toHaveLength(1);
});

it("adds terminal punctuation only with a sentence-start signal in the following segment", async () => {
  const before = { ...raw, text: "we went home" };
  const next = { ...raw, id: "next", text: "Then we slept", confidence: 0.99 };
  const result = await correctSegments([before, next], {
    mode: "quick",
    words: [],
    signal,
    generate: async () =>
      JSON.stringify({
        segments: [{ ...raw, text: "we went home.", uncertain: false }],
        suggestions: [],
      }),
  });
  expect(result.segments[0]?.text).toBe("we went home.");
});

it("estimates transcript tokens per script instead of counting UTF-8 bytes", () => {
  const first = estimateCorrection(
    "quick",
    [],
    true,
    undefined,
    [{ ...raw, text: "a".repeat(100) }],
    0,
  );
  const second = estimateCorrection(
    "quick",
    [],
    true,
    undefined,
    [{ ...raw, text: "א".repeat(100) }],
    0,
  );
  const third = estimateCorrection(
    "quick",
    [],
    true,
    undefined,
    [{ ...raw, text: "文".repeat(100) }],
    0,
  );
  expect(second.inputTokens - first.inputTokens).toBe(50);
  expect(third.inputTokens - second.inputTokens).toBe(100);
});

it("reports remaining targets when the estimate caps generation", async () => {
  const result = await correctSegments([raw], {
    mode: "quick",
    words: [],
    signal,
    maxCalls: 0,
    generate: async () => {
      throw new Error("Exceeded estimate");
    },
  });
  expect(result.correctionOutcome).toMatchObject({
    status: "partial",
    reason: "estimate-exhausted",
    skippedWindows: 1,
  });
});

it("recovers a wrapped reply that fails the correction contract and keeps the glossary proposal", async () => {
  const target = { ...raw, id: "2-0", start: 52.032, end: 77.504, text: "Anna Bell was speaking." };
  const words = [
    { term: "Anna Bell", preferred: "Ana Bell", language: "en", source: "user" as const },
  ];
  const payload = {
    segments: [{ ...target, text: "Ana Bell was speaking.", uncertain: false, protected: true }],
    suggestions: [],
  };
  const result = await correctSegments([target], {
    mode: "quick",
    words,
    signal,
    maxCalls: 2,
    generate: async (prompt, attempt) => {
      if (attempt === "initial") return JSON.stringify({ transcription: JSON.stringify(payload) });
      expect(prompt).toContain("Repair the prior response (schema-mismatch)");
      return ["```json", JSON.stringify(payload), "```"].join("\n");
    },
  });
  expect(result.correctionOutcome).toMatchObject({ status: "completed", rejectedWindows: 0 });
  expect(result.reviewItems).toEqual([
    expect.objectContaining({ segmentId: target.id, after: "Ana Bell was speaking." }),
  ]);
  expect(result.correctionRejections).toEqual([
    { window: 0, attempt: 1, reason: "schema-mismatch" },
  ]);
});

it("records validation failures without retaining rejected model text", async () => {
  let attempts = 0;
  const result = await correctSegments([raw], {
    mode: "quick",
    words: [],
    signal,
    maxCalls: 2,
    generate: async () => {
      attempts++;
      return JSON.stringify({
        segments: [{ ...raw, end: raw.end + 1, text: "Untrusted", uncertain: false }],
        suggestions: [],
      });
    },
  });
  expect(attempts).toBe(2);
  expect(result.segments[0]?.text).toBe(raw.text);
  expect(result.correctionOutcome).toMatchObject({
    status: "skipped",
    reason: "invalid-model-output",
  });
  expect(result.correctionRejections.map(({ reason }) => reason)).toEqual([
    "timestamp-mismatch",
    "timestamp-mismatch",
  ]);
  expect(JSON.stringify(result)).not.toContain("Untrusted");
});
