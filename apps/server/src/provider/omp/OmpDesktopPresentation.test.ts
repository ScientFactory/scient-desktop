import { describe, expect, it } from "@effect/vitest";
import {
  ompCommandOutputText,
  ompMessageUsage,
  ompStatsUsage,
  ompTodoSteps,
} from "./OmpDesktopPresentation.ts";

describe("OMP desktop observations", () => {
  it("keeps cache tokens in context occupancy and rejects invalid counters", () => {
    expect(
      ompMessageUsage({ input: 10, cacheRead: 20, cacheWrite: 30, output: 5 }, 200),
    ).toMatchObject({ usedTokens: 65, inputTokens: 60, cachedInputTokens: 20, maxTokens: 200 });
    expect(ompMessageUsage({ input: -1, totalTokens: 20 })).toBeUndefined();
    expect(ompMessageUsage({ unrelated: 1 })).toBeUndefined();
    expect(ompStatsUsage({ cost: NaN })).toBeUndefined();
    expect(ompStatsUsage({}, { usedTokens: 20 })).toBeUndefined();
  });

  it("replaces authoritative cost without counting cache refresh usage twice", () => {
    expect(
      ompStatsUsage(
        {
          sessionId: "session",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 30, total: 65 },
          premiumRequests: 0,
          cost: 1.5,
        },
        { usedTokens: 60, maxTokens: 200, cost: { amount: 1, currency: "USD" } },
      ),
    ).toMatchObject({ usedTokens: 60, maxTokens: 200, cost: { amount: 1.5, currency: "USD" } });
  });

  it("preserves phase and blocked/abandoned meaning in the shared todo statuses", () => {
    expect(
      ompTodoSteps([
        {
          name: "Phase",
          tasks: [
            { content: "Await review", status: "blocked", blocker: "Owner input" },
            { content: "Discarded", status: "abandoned" },
          ],
        },
      ]),
    ).toMatchObject([
      { text: "Phase: Await review (blocked: Owner input)", status: "pending" },
      { text: "Phase: Discarded (abandoned)", status: "completed" },
    ]);
    expect(
      ompTodoSteps([{ name: "Phase", tasks: [{ content: "Unknown", status: "new_state" }] }]),
    ).toBeUndefined();
    expect(ompTodoSteps([])).toEqual([]);
  });
});

describe("ompCommandOutputText", () => {
  it("drops terminal colors and keeps a meter's columns in a code block", () => {
    expect(ompCommandOutputText("Used\n  Tools \u001b[38;5;39m██░░\u001b[39m 2%")).toBe(
      "\n```text\nUsed\n  Tools ██░░ 2%\n```\n",
    );
  });

  it("keeps a report's own code block", () => {
    expect(ompCommandOutputText("```\n  [██░░] 10%\n```")).toBe("```\n  [██░░] 10%\n```\n\n");
  });

  it("leaves plain reports as chat text", () => {
    expect(ompCommandOutputText("No background jobs running.")).toBe(
      "No background jobs running.\n\n",
    );
  });
});
