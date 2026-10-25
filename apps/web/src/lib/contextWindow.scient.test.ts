import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { deriveLatestContextWindowSnapshot } from "./contextWindow";

describe("provider cost alongside turn context", () => {
  it("keeps authoritative session cost while live counters own the context meter", () => {
    const live = { usedTokens: 65, maxTokens: 200, updatedAt: "2026-10-25T12:00:00.000Z" };
    const providerThread = {
      contextUsage: { usedTokens: 50, cost: { amount: 1.25, currency: "USD" } },
      updatedAt: DateTime.makeUnsafe(live.updatedAt),
    };
    expect(deriveLatestContextWindowSnapshot([], live, providerThread)).toMatchObject({
      usedTokens: 65,
      maxTokens: 200,
      cost: { amount: 1.25, currency: "USD" },
    });
    providerThread.contextUsage.cost.amount = 1.5;
    expect(deriveLatestContextWindowSnapshot([], live, providerThread)?.cost?.amount).toBe(1.5);
    expect(deriveLatestContextWindowSnapshot([], live)?.cost).toBeNull();
  });
});
