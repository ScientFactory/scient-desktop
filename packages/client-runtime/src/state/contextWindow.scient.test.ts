import { ProviderThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { deriveLatestContextWindowSnapshot, shouldOfferResumeCompaction } from "./contextWindow.ts";

describe("provider cost alongside turn context", () => {
  it("keeps authoritative session cost while live counters own the context meter", () => {
    const live = { usedTokens: 65, maxTokens: 200, updatedAt: "2026-10-25T12:00:00.000Z" };
    const providerThread = {
      id: ProviderThreadId.make("provider-thread"),
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

describe("compaction on return for Scient Agent", () => {
  it("offers it once the cache lifetime the agent reported has passed", () => {
    const updatedAt = "2026-11-13T12:00:00.000Z";
    const offer = (now: string) =>
      shouldOfferResumeCompaction({
        provider: "scient",
        usedTokens: 300_000,
        updatedAt,
        promptCacheTtlMs: 3_600_000,
        now,
      });
    expect(offer("2026-11-13T12:59:59.999Z")).toBe(false);
    expect(offer("2026-11-13T13:00:00.000Z")).toBe(true);
  });
});
