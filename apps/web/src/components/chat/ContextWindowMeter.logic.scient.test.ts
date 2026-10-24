import { describe, expect, it } from "vite-plus/test";
import { shouldCompactBeforeSend } from "./ContextWindowMeter.logic";

describe("resume compaction send admission", () => {
  const ordinary = {
    ordinaryServerSend: true,
    hasCapturedQueueSubmission: false,
    multipleModels: false,
    resumeCompactionTokens: 120_000,
    keepFullHistory: false,
    messageText: "Continue",
  };
  it("compacts an ordinary stale-session send", () => {
    expect(shouldCompactBeforeSend(ordinary)).toBe(true);
  });
  // One row per guard in shouldCompactBeforeSend.
  it.each([
    { ordinaryServerSend: false },
    { hasCapturedQueueSubmission: true },
    { multipleModels: true },
    { resumeCompactionTokens: null },
    { keepFullHistory: true },
    { messageText: " /COMPACT " },
    { messageText: "/compact keep the API notes" },
  ])(
    "preserves a special action, immutable retry, full-history choice or explicit command: %j",
    (override) => {
      expect(shouldCompactBeforeSend({ ...ordinary, ...override })).toBe(false);
    },
  );
  it("still compacts a message whose first word merely starts with compact", () => {
    expect(shouldCompactBeforeSend({ ...ordinary, messageText: "/compactfoo" })).toBe(true);
  });
});
