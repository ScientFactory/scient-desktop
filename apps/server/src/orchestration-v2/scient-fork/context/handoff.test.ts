import { describe, expect, it } from "@effect/vitest";

import { handoffTokenCap } from "./handoffBudget.ts";
import { nativeThreadKey } from "./nativeThreadKey.ts";

describe("Scient handoff presets", () => {
  it("maps presets to caps and lets the environment override win", () => {
    expect(handoffTokenCap("compact", undefined)).toBe(16_000);
    expect(handoffTokenCap("standard", undefined)).toBe(64_000);
    expect(handoffTokenCap("maximum", undefined)).toBeNull();
    expect(handoffTokenCap("standard", 5_000)).toBe(5_000);
    expect(handoffTokenCap("standard", 10)).toBe(1_024);
  });
});

describe("nativeThreadKey", () => {
  it("reads each provider's own session identity", () => {
    expect(nativeThreadKey("codex", { threadId: "thr_1" })).toBe("codex:thr_1");
    // Claude's cursor threadId is Scient's thread id; its session is `resume`.
    expect(nativeThreadKey("claudeAgent", { threadId: "scient-thread", resume: "s-1" })).toBe(
      "claudeAgent:s-1",
    );
    expect(nativeThreadKey("claudeAgent", { threadId: "scient-thread" })).toBeNull();
    expect(nativeThreadKey("opencode", { schemaVersion: 1, sessionId: "ses" })).toBe(
      "opencode:ses",
    );
    expect(nativeThreadKey("pi", { sessionFile: "/tmp/s.jsonl" })).toBe("pi:/tmp/s.jsonl");
    expect(nativeThreadKey("codex", null)).toBeNull();
    expect(nativeThreadKey("codex", { threadId: "same-id" }, "instance-a")).not.toBe(
      nativeThreadKey("codex", { threadId: "same-id" }, "instance-b"),
    );
  });
});
