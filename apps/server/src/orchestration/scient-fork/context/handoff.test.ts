import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ThreadForkMidTurnCut,
} from "@t3tools/contracts";
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
import { buildHandoffItems, renderHandoff, selectHistory } from "./handoffHistory.ts";
import { nativeThreadKey } from "./nativeThreadKey.ts";

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  turnId: string | null,
  minute: number,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`,
  updatedAt: `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`,
});

const tool = (
  id: string,
  kind: string,
  turnId: string,
  minute: number,
  toolCallId = id,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind,
  summary: `tool ${id}`,
  payload: { toolCallId, detail: "npm test", data: { output: `output of ${id}` } },
  turnId: TurnId.make(turnId),
  createdAt: `2026-09-26T10:${String(minute).padStart(2, "0")}:30.000Z`,
});

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

describe("buildHandoffItems", () => {
  it("keeps reasoning, answers and the latest state of each tool call in timeline order", () => {
    const items = buildHandoffItems({
      messages: [
        message("u1", "user", "Run the tests", "t1", 1),
        message("r1", "reasoning", "I should run npm test", "t1", 2),
        message("a1", "assistant", "All green", "t1", 4),
        message("next", "user", "Now deploy", null, 9),
      ],
      activities: [
        tool("progress", "tool.updated", "t1", 2, "call-1"),
        tool("done", "tool.completed", "t1", 3, "call-1"),
      ],
      proposedPlans: [],
      beforeMessageId: "next",
      midTurnCut: undefined,
    });
    expect(items.map((item) => [item.kind, item.itemId])).toEqual([
      ["user_message", "u1"],
      ["reasoning", "r1"],
      ["tool", "done"],
      ["assistant_message", "a1"],
    ]);
    expect(items.find((item) => item.kind === "tool")?.fields.output).toContain("output of done");
  });

  it("excludes the current message and anything after it", () => {
    const items = buildHandoffItems({
      messages: [message("u1", "user", "first", "t1", 1), message("next", "user", "now", null, 5)],
      activities: [tool("late", "tool.completed", "t1", 6)],
      proposedPlans: [],
      beforeMessageId: "next",
      midTurnCut: undefined,
    });
    expect(items.map((item) => item.itemId)).toEqual(["u1"]);
  });

  it("labels a mid-turn cut: partial text and unfinished tool calls", () => {
    const cut: ThreadForkMidTurnCut = {
      sourceTurnId: TurnId.make("src"),
      importedTurnId: TurnId.make("t2"),
      cutSequence: 42,
      partialMessageIds: [MessageId.make("r2")],
      inFlightActivityIds: [EventId.make("running")],
      pendingRequests: [],
      touchedFiles: ["src/fit.py"],
      sharedWorkspace: true,
    };
    const items = buildHandoffItems({
      messages: [
        message("u2", "user", "Fit the model", "t2", 1),
        message("r2", "reasoning", "Trying a quadratic", "t2", 2),
      ],
      activities: [tool("running", "tool.started", "t2", 3)],
      proposedPlans: [],
      beforeMessageId: "missing",
      midTurnCut: cut,
    });
    expect(items.find((item) => item.itemId === "r2")?.partial).toBe(true);
    expect(items.find((item) => item.itemId === "running")?.fields.status).toBe("in_flight");
    const rendered = renderHandoff({
      threadId: "fork",
      title: "Fit",
      selection: selectHistory({ items, budget: 10_000, currentAttachments: [], midTurnCut: cut }),
      totalItemCount: items.length,
      midTurnCut: cut,
    });
    expect(rendered.preamble).toContain("still running in this same folder");
    expect(rendered.preamble).toContain("src/fit.py");
  });
});

describe("selectHistory", () => {
  it("tells the provider about gaps in imported source history", () => {
    const rendered = renderHandoff({
      threadId: "imported-thread",
      title: "Partial transcript",
      selection: selectHistory({
        items: [],
        budget: 1_000,
        currentAttachments: [],
        midTurnCut: undefined,
      }),
      totalItemCount: 0,
      midTurnCut: undefined,
      imported: true,
      importOmissions: [{ _tag: "range-truncated", throughMessageN: 4 }],
    });
    expect(rendered.preamble).toContain('"knownSourceOmissions"');
    expect(rendered.preamble).toContain('"throughMessageN":4');
    expect(rendered.preamble).toContain("cannot be recovered");
  });

  const conversation = Array.from({ length: 20 }, (_, index) =>
    message(
      `m${index}`,
      index % 2 === 0 ? "user" : "assistant",
      `message ${index} ${"x".repeat(600)}`,
      `t${Math.floor(index / 2)}`,
      index,
    ),
  );
  const items = buildHandoffItems({
    messages: [
      ...conversation.slice(0, 19),
      message("r-last", "reasoning", "latest thinking", "t9", 19),
      conversation[19]!,
    ],
    activities: [],
    proposedPlans: [],
    beforeMessageId: "none",
    midTurnCut: undefined,
  });

  it("keeps V2's anchors and the latest turn's thinking before older conversation", () => {
    const selection = selectHistory({
      items,
      budget: 1_200,
      currentAttachments: [],
      midTurnCut: undefined,
    });
    const kept = selection.items.map((item) => item.itemId);
    expect(kept).toEqual(expect.arrayContaining(["m0", "m18", "m19", "r-last"]));
    expect(selection.omittedItemIds.length).toBeGreaterThan(0);
    expect(selection.usedTokens).toBeLessThanOrEqual(1_200);
  });

  it("keeps an anchor that does not fit whole as a truncated item", () => {
    const huge = [
      message("u", "user", `start ${"y".repeat(20_000)} end`, "t1", 1),
      message("a", "assistant", "ok", "t1", 2),
    ];
    const selection = selectHistory({
      items: buildHandoffItems({
        messages: huge,
        activities: [],
        proposedPlans: [],
        beforeMessageId: "none",
        midTurnCut: undefined,
      }),
      budget: 2_000,
      currentAttachments: [],
      midTurnCut: undefined,
    });
    const user = selection.items.find((item) => item.itemId === "u");
    expect(user?.truncated).toBe(true);
    expect(user?.text).toContain("start");
    expect(user?.text).toContain("end");
    expect(selection.usedTokens).toBeLessThanOrEqual(2_000);
  });
});

describe("attachment reattachment", () => {
  it("names captured-window images instead of reattaching them", () => {
    const captured = {
      type: "image" as const,
      id: "capture-1",
      name: "window.png",
      mimeType: "image/png",
      sizeBytes: 10,
      source: { kind: "snap-shot" as const, capturedAt: "2026-09-26T10:00:00.000Z" },
    };
    const plain = {
      type: "image" as const,
      id: "plain-1",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const items = buildHandoffItems({
      messages: [
        { ...message("u1", "user", "look", "t1", 1), attachments: [captured, plain] },
        message("a1", "assistant", "ok", "t1", 2),
      ],
      activities: [],
      proposedPlans: [],
      beforeMessageId: "none",
      midTurnCut: undefined,
    });
    const selection = selectHistory({
      items,
      budget: 100_000,
      currentAttachments: [],
      midTurnCut: undefined,
    });
    expect(selection.reattached.map((attachment) => attachment.id)).toEqual(["plain-1"]);
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
