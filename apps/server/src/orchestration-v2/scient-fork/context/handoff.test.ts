import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import {
  classifyTurnDispatchFailure,
  markTurnDispatchAttempted,
} from "../../../provider/turnDispatchPhase.ts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  estimateTokens,
  handoffBudget,
  handoffTokenCap,
} from "./handoffBudget.ts";
import { nativeThreadKey } from "./nativeThreadKey.ts";

describe("handoffBudget", () => {
  it("applies V2's formula with an unknown window defaulting to 128k", () => {
    const budget = handoffBudget({
      tokenCap: null,
      userText: "",
      attachments: [],
      usage: undefined,
      nativeUsedTokens: 0,
    });
    const reserve = Math.ceil(DEFAULT_MODEL_CONTEXT_WINDOW / 4);
    expect(budget).toBe(DEFAULT_MODEL_CONTEXT_WINDOW - estimateTokens("") - reserve);
  });

  it("is bounded by the preset cap, the compaction threshold and native usage", () => {
    const usage = { maxTokens: 1_000_000, autoCompactThreshold: 200_000 };
    expect(
      handoffBudget({
        tokenCap: 64_000,
        userText: "hi",
        attachments: [],
        usage,
        nativeUsedTokens: 0,
      }),
    ).toBe(64_000);
    const nearlyFull = handoffBudget({
      tokenCap: null,
      userText: "hi",
      attachments: [],
      usage,
      nativeUsedTokens: 140_000,
    });
    expect(nearlyFull).toBe(200_000 - 140_000 - estimateTokens("hi") - 50_000);
    expect(
      handoffBudget({
        tokenCap: null,
        userText: "",
        attachments: [],
        usage,
        nativeUsedTokens: 190_000,
      }),
    ).toBe(0);
  });

  it("charges V2's attachment allowances against the current input", () => {
    const withImage = handoffBudget({
      tokenCap: null,
      userText: "",
      attachments: [{ type: "image", id: "i", name: "a.png", mimeType: "image/png", sizeBytes: 1 }],
      usage: undefined,
      nativeUsedTokens: 0,
    });
    const without = handoffBudget({
      tokenCap: null,
      userText: "",
      attachments: [],
      usage: undefined,
      nativeUsedTokens: 0,
    });
    expect(without - withImage).toBe(8_192);
  });

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

describe("classifyTurnDispatchFailure", () => {
  it("treats failures before dispatch as not sent and later ones as maybe delivered", () => {
    const before = new Error("validation");
    expect(classifyTurnDispatchFailure(Cause.fail(before))).toBe("notSent");
    const after = new Error("transport");
    markTurnDispatchAttempted(after);
    expect(classifyTurnDispatchFailure(Cause.fail(after))).toBe("maybeDelivered");
    expect(classifyTurnDispatchFailure(Cause.die(new Error("defect")))).toBe("maybeDelivered");
  });
});
