import { describe, expect, it } from "@effect/vitest";

import { makePiUsageReducer } from "./piUsage.ts";

function assistant(input: {
  id: string;
  parentId: string;
  responseId: string;
  model?: string;
  input?: number;
}) {
  return JSON.stringify({
    type: "message",
    id: input.id,
    parentId: input.parentId,
    timestamp: "2026-09-20T12:00:00.000Z",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: input.model ?? "z-ai/glm-5.3-flash",
      responseId: input.responseId,
      usage: {
        input: input.input ?? 100,
        output: 20,
        reasoning: 7,
        cacheRead: 5,
        cacheWrite: 3,
        cost: { total: 0.004 },
      },
    },
  });
}

describe("pi usage reducer", () => {
  it("inherits the nearest branch-local Scient connection and deduplicates generations", () => {
    const reducer = makePiUsageReducer({
      timeZone: "UTC",
      sinceDay: "2026-09-01",
      untilDay: "2026-09-30",
    });
    for (const line of [
      JSON.stringify({ type: "session", id: "session-a" }),
      JSON.stringify({
        type: "model_change",
        id: "root",
        parentId: null,
        provider: "scient_conn-a",
      }),
      assistant({ id: "a1", parentId: "root", responseId: "gen-a" }),
      JSON.stringify({
        type: "model_change",
        id: "branch",
        parentId: "root",
        provider: "scient_conn-b",
      }),
      assistant({ id: "b1", parentId: "branch", responseId: "gen-b", model: "deepseek/v3" }),
      assistant({ id: "a2", parentId: "a1", responseId: "gen-c" }),
      assistant({ id: "duplicate", parentId: "root", responseId: "gen-a" }),
    ])
      reducer.addLine(line);

    const rows = reducer.finish();
    expect(rows.map((row) => [row.connectionId, row.model, row.records])).toEqual([
      ["conn-a", "z-ai/glm-5.3-flash", 2],
      ["conn-b", "deepseek/v3", 1],
    ]);
    expect(rows[0]?.totals).toMatchObject({ uncachedInputTokens: 200, outputTokens: 40 });
    expect(rows[0]?.generations).toBe(2);
  });

  it("ignores messages outside the window, malformed lines, and native pi changes", () => {
    const reducer = makePiUsageReducer({
      timeZone: "UTC",
      sinceDay: "2026-09-20",
      untilDay: "2026-09-20",
    });
    reducer.addLine("not-json");
    reducer.addLine(JSON.stringify({ type: "model_change", id: "native", provider: "openrouter" }));
    reducer.addLine(assistant({ id: "ignored", parentId: "native", responseId: "gen-x" }));
    expect(reducer.finish()).toEqual([]);
  });

  it("deduplicates copied session entries even when a response ID is absent", () => {
    const reducer = makePiUsageReducer({
      timeZone: "UTC",
      sinceDay: "2026-09-20",
      untilDay: "2026-09-20",
    });
    reducer.addLine(JSON.stringify({ type: "session", id: "session-a" }));
    reducer.addLine(JSON.stringify({ type: "model_change", id: "root", provider: "scient_a" }));
    const withoutResponseId = JSON.parse(
      assistant({ id: "message-a", parentId: "root", responseId: "" }),
    ) as { message: Record<string, unknown> };
    delete withoutResponseId.message["responseId"];
    reducer.addLine(JSON.stringify(withoutResponseId));
    reducer.addLine(JSON.stringify(withoutResponseId));

    expect(reducer.finish()[0]?.records).toBe(1);
  });

  it("reduces a 50,000-response synthetic session without losing totals", () => {
    const reducer = makePiUsageReducer({
      timeZone: "UTC",
      sinceDay: "2026-09-20",
      untilDay: "2026-09-20",
    });
    reducer.addLine(JSON.stringify({ type: "session", id: "stress" }));
    reducer.addLine(
      JSON.stringify({ type: "model_change", id: "root", provider: "scient_stress" }),
    );
    let parentId = "root";
    for (let index = 0; index < 50_000; index += 1) {
      const id = `m-${index}`;
      reducer.addLine(assistant({ id, parentId, responseId: `gen-${index}`, input: 1 }));
      parentId = id;
    }
    const [row] = reducer.finish();
    expect(row?.records).toBe(50_000);
    expect(row?.totals.uncachedInputTokens).toBe(50_000);
    expect(row?.estimatedCostUsd).toBeCloseTo(200, 6);
  });
});
