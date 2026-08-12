import { describe, expect, it } from "@effect/vitest";

import { executionOutputContentParts } from "./outputContent.ts";

const canonicalContent = (chunks: Parameters<typeof executionOutputContentParts>[0]): string =>
  [...executionOutputContentParts(chunks)].join("");

describe("execution output content", () => {
  it("canonically preserves order, stream identity, and text without timestamps", () => {
    const first = canonicalContent([
      { sequence: 0, stream: "stdout", text: "value\n", observedAt: "2026-08-12T00:00:00Z" },
      { sequence: 1, stream: "stderr", text: "warning\n", observedAt: "2026-08-12T00:00:01Z" },
    ]);
    const laterObservation = canonicalContent([
      { sequence: 8, stream: "stdout", text: "value\n", observedAt: "2027-01-01T00:00:00Z" },
      { sequence: 9, stream: "stderr", text: "warning\n", observedAt: "2027-01-01T00:00:01Z" },
    ]);
    const differentStream = canonicalContent([
      { sequence: 0, stream: "stdout", text: "value\n", observedAt: "2026-08-12T00:00:00Z" },
      { sequence: 1, stream: "stdout", text: "warning\n", observedAt: "2026-08-12T00:00:01Z" },
    ]);

    expect(first).toEqual(laterObservation);
    expect(first).not.toEqual(differentStream);
  });
});
