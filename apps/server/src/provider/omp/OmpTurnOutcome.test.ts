import { describe, expect, it } from "vite-plus/test";

import {
  OMP_ERROR_MESSAGE_MAX_CHARS,
  classifyOmpTurnOutcome,
  clipOmpErrorMessage,
  type OmpTurnEvidence,
  type OmpTurnVerdict,
} from "./OmpTurnOutcome.ts";

const terminal = { settlement: "terminal", cancelRequested: false } as const;

const cases: ReadonlyArray<readonly [string, OmpTurnEvidence, OmpTurnVerdict]> = [
  [
    "an unconfirmed drain is uncertain, even with a user cancel",
    { settlement: "unconfirmed", cancelRequested: true, stopReason: "error" },
    { outcome: "unknown" },
  ],
  [
    "a user cancel is interrupted, even when the model also failed",
    { ...terminal, cancelRequested: true, stopReason: "error", errorMessage: "boom" },
    { outcome: "interrupted" },
  ],
  [
    "an acknowledged abort is interrupted",
    { settlement: "cancel-confirmed", cancelRequested: true },
    { outcome: "interrupted" },
  ],
  [
    "a provider abort without a user cancel fails with stopReason abort",
    { ...terminal, stopReason: "aborted", errorMessage: "Request was aborted" },
    { outcome: "failed", stopReason: "abort", errorMessage: "Request was aborted" },
  ],
  [
    "prompt_result aborted fails with a fallback message",
    { ...terminal, promptStatus: "aborted" },
    { outcome: "failed", stopReason: "abort", errorMessage: "Oh My Pi aborted this turn." },
  ],
  [
    "a model error fails with the message's error",
    { ...terminal, stopReason: "error", errorMessage: "401 invalid API key" },
    { outcome: "failed", stopReason: "error", errorMessage: "401 invalid API key" },
  ],
  [
    "a model error prefers the retry's final error",
    {
      ...terminal,
      stopReason: "error",
      errorMessage: "429 attempt 3",
      retryExhausted: true,
      retryFinalError: "429 after 3 attempts",
    },
    { outcome: "failed", stopReason: "error", errorMessage: "429 after 3 attempts" },
  ],
  [
    "prompt_result error without a message error uses the prompt error",
    { ...terminal, promptStatus: "error", promptError: "provider unavailable" },
    { outcome: "failed", stopReason: "error", errorMessage: "provider unavailable" },
  ],
  [
    "a model error with no text at all still has a message",
    { ...terminal, stopReason: "error", errorMessage: "   " },
    { outcome: "failed", stopReason: "error", errorMessage: "Oh My Pi failed this turn." },
  ],
  [
    "an exhausted retry fails even when the last stop was not an error",
    { ...terminal, stopReason: "stop", retryExhausted: true, retryFinalError: "Retry cancelled" },
    { outcome: "failed", stopReason: "error", errorMessage: "Retry cancelled" },
  ],
  [
    "prompt_result completed outranks a stale error stop",
    { ...terminal, promptStatus: "completed", stopReason: "error", errorMessage: "old" },
    { outcome: "completed" },
  ],
  [
    "a length stop completes with its stop reason",
    { ...terminal, stopReason: "length", promptStatus: "completed" },
    { outcome: "completed", stopReason: "length" },
  ],
  [
    "a tool-use stop after a recovered retry completes",
    { ...terminal, stopReason: "toolUse", promptStatus: "completed" },
    { outcome: "completed" },
  ],
  ["no evidence at all completes", terminal, { outcome: "completed" }],
  [
    "an unknown prompt status falls back to the message evidence",
    { ...terminal, promptStatus: "paused", stopReason: "error", errorMessage: "boom" },
    { outcome: "failed", stopReason: "error", errorMessage: "boom" },
  ],
];

describe("classifyOmpTurnOutcome", () => {
  it.each(cases)("%s", (_label, evidence, verdict) => {
    expect(classifyOmpTurnOutcome(evidence)).toEqual(verdict);
  });

  it("clips error messages to 512 characters and never returns an empty one", () => {
    const clipped = clipOmpErrorMessage("x".repeat(2000));
    expect(clipped).toHaveLength(OMP_ERROR_MESSAGE_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipOmpErrorMessage("  detail  ")).toBe("detail");
    expect(clipOmpErrorMessage(undefined)).toBe("Oh My Pi failed this turn.");
  });
});
