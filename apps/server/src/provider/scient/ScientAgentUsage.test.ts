import { assert, describe, expect, it } from "@effect/vitest";
import type { ProviderConnectionAccount } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  readScientAgentUsageLimits,
  scientAgentUsageLimits,
  scientAgentUsageReader,
} from "./ScientAgentUsage.ts";
import {
  decodeScanCache,
  makeScanCacheWriter,
  type CachedFile,
} from "../../usage/usageScanCache.ts";

const CHECKED_AT = "2026-11-13T12:00:00.000Z";
const FETCHED_MS = Date.parse("2026-11-13T11:58:00.000Z");
const FETCHED_AT = "2026-11-13T11:58:00.000Z";
const RESET_MS = Date.parse("2026-11-16T09:00:00.000Z");
const accounts: ReadonlyArray<ProviderConnectionAccount> = [
  { id: "openai-codex", name: "ChatGPT", kind: "account", connected: true, canDisconnect: true },
  { id: "anthropic", name: "Claude", kind: "account", connected: true, canDisconnect: true },
];
const models = [
  { slug: "anthropic/claude-opus-5-5" },
  { slug: "anthropic/claude-sonnet-5-5" },
  { slug: "anthropic/claude-fable-5-1" },
  { slug: "anthropic/claude-mythos-5-2" },
  { slug: "openai-codex/gpt-6.1-sol" },
  { slug: "openai-codex/gpt-5.3-codex-spark" },
];

// The shape `scient-agent usage --json` printed for a ChatGPT account (0.1.5, identities removed).
const chatGpt = {
  provider: "openai-codex",
  fetchedAt: FETCHED_MS,
  metadata: { email: "a@example.invalid", accountId: "acct", planType: "plus" },
  limits: [
    {
      id: "openai-codex:primary",
      label: "7 days",
      scope: { windowId: "7d", shared: true },
      window: { id: "7d", label: "7 days", durationMs: 604_800_000, resetsAt: RESET_MS },
      amount: { used: 33, limit: 100, usedFraction: 0.33, unit: "percent" },
      status: "ok",
    },
  ],
};

describe("scientAgentUsageLimits", () => {
  it("shows each account's windows under the account's name, preserving status, accountId, and fetchedAt", () => {
    const limits = scientAgentUsageLimits({
      output: { reports: [chatGpt] },
      accounts,
      checkedAt: CHECKED_AT,
    });
    assert.deepStrictEqual(limits, {
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: "openai-codex:primary",
          kind: "weekly",
          label: "ChatGPT · 7 days",
          providerIds: ["openai-codex"],
          accountId: "openai-codex#1",
          status: "ok",
          fetchedAt: FETCHED_AT,
          usedPercent: 33,
          resetsAt: "2026-11-16T09:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("tells two accounts of one provider apart and keeps display percent separate from availability status", () => {
    const fiveHours = {
      id: "anthropic:5h",
      label: "5 hours",
      window: { id: "5h", label: "5 hours", durationMs: 18_000_000 },
      amount: { unit: "percent", remainingFraction: 0.25 },
    };
    const limits = scientAgentUsageLimits({
      output: {
        reports: [
          {
            provider: "anthropic",
            metadata: { email: "one@example.invalid" },
            limits: [fiveHours],
          },
          {
            provider: "anthropic",
            metadata: { email: "two@example.invalid" },
            limits: [
              { ...fiveHours, status: "exhausted", amount: { unit: "percent", used: 90 } },
              {
                id: "anthropic:7d",
                label: "7 days",
                scope: { windowId: "7d", shared: true },
                window: { id: "7d", label: "7 days", durationMs: 604_800_000 },
                amount: { unit: "percent", used: 100 },
                status: "warning",
              },
              { id: "anthropic:opaque", label: "Credits", amount: { unit: "credits" } },
            ],
          },
        ],
      },
      accounts,
      checkedAt: CHECKED_AT,
    });
    assert.deepStrictEqual(
      limits.windows.map((window) => [
        window.id,
        window.kind,
        window.label,
        window.accountId,
        window.usedPercent,
        window.status,
      ]),
      [
        [
          "anthropic:5h",
          "session",
          "Claude (one@example.invalid) · 5 hours",
          "anthropic#1",
          75,
          "ok",
        ],
        [
          "anthropic:5h#2",
          "session",
          "Claude (two@example.invalid) · 5 hours",
          "anthropic#2",
          90,
          "exhausted",
        ],
        [
          "anthropic:7d#2",
          "weekly",
          "Claude (two@example.invalid) · 7 days",
          "anthropic#2",
          100,
          "warning",
        ],
      ],
    );
  });

  it("preserves model-scoped limits, overflow gating flags, and unreported sibling accounts", () => {
    const limits = scientAgentUsageLimits({
      output: {
        reports: [
          {
            provider: "anthropic",
            fetchedAt: FETCHED_MS,
            metadata: { email: "claude@example.invalid" },
            limits: [
              {
                id: "anthropic:5h",
                label: "Claude 5 Hour",
                scope: { windowId: "5h", shared: true },
                window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: RESET_MS },
                amount: { used: 40, limit: 100, usedFraction: 0.4, unit: "percent" },
                status: "ok",
              },
              {
                id: "anthropic:7d:fable",
                label: "Claude 7 Day (Fable)",
                scope: { windowId: "7d", tier: "fable" },
                window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: RESET_MS },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
                status: "exhausted",
              },
              {
                id: "anthropic:7d:fable-no-reset",
                label: "Claude 7 Day (Fable)",
                scope: { windowId: "7d", tier: "fable" },
                window: { id: "7d", label: "7 Day", durationMs: 604_800_000 },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
                status: "exhausted",
              },
              {
                id: "anthropic:extra",
                label: "Claude Extra Usage",
                scope: { windowId: "extra" },
                amount: { used: 50, limit: 50, usedFraction: 1, unit: "usd" },
                status: "exhausted",
              },
            ],
          },
          {
            provider: "openai-codex",
            fetchedAt: FETCHED_MS,
            metadata: { email: "codex@example.invalid" },
            limits: [
              {
                id: "openai-codex:primary",
                label: "5 hours",
                scope: { windowId: "5h", shared: true },
                window: { id: "5h", label: "5 hours", durationMs: 18_000_000, resetsAt: RESET_MS },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
                status: "warning",
              },
              {
                id: "openai-codex:spark:primary",
                label: "5 hours (Spark)",
                scope: {
                  tier: "spark",
                  modelId: "GPT-5.3-Codex-Spark",
                  windowId: "5h",
                  shared: true,
                },
                window: { id: "5h", label: "5 hours", durationMs: 18_000_000, resetsAt: RESET_MS },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
                status: "exhausted",
              },
              {
                id: "openai-codex:spend-cap",
                label: "Spend cap",
                scope: {
                  tier: "credits",
                  windowId: "spend-cap",
                  shared: true,
                },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "credits" },
                status: "exhausted",
              },
            ],
          },
        ],
        accountsWithoutUsage: [{ provider: "anthropic" }],
      },
      accounts,
      models,
      checkedAt: CHECKED_AT,
    });

    const byId = new Map(limits.windows.map((window) => [window.id, window]));
    assert.isUndefined(byId.get("anthropic:5h")?.modelIds);
    assert.deepStrictEqual(byId.get("anthropic:7d:fable")?.modelIds, [
      "anthropic/claude-fable-5-1",
      "anthropic/claude-mythos-5-2",
    ]);
    assert.strictEqual(byId.get("anthropic:7d:fable")?.label, "Claude · 7 Day (Fable)");
    assert.isUndefined(byId.get("anthropic:7d:fable")?.gating);
    assert.strictEqual(byId.get("anthropic:7d:fable-no-reset")?.gating, false);
    assert.strictEqual(byId.get("anthropic:extra")?.gating, false);

    assert.deepStrictEqual(byId.get("openai-codex:primary")?.modelIds, [
      "openai-codex/gpt-6.1-sol",
    ]);
    assert.strictEqual(byId.get("openai-codex:primary")?.usedPercent, 100);
    assert.strictEqual(byId.get("openai-codex:primary")?.status, "warning");
    assert.deepStrictEqual(byId.get("openai-codex:spark:primary")?.modelIds, [
      "openai-codex/gpt-5.3-codex-spark",
    ]);
    assert.strictEqual(byId.get("openai-codex:spark:primary")?.label, "ChatGPT · 5 hours (Spark)");
    assert.strictEqual(byId.get("openai-codex:spend-cap")?.gating, false);
    assert.deepStrictEqual(limits.unknownProviderIds, ["anthropic"]);
  });

  it("keeps an account unknown when a binding meter has no reading", () => {
    const limits = scientAgentUsageLimits({
      output: {
        reports: [
          {
            ...chatGpt,
            limits: [
              ...chatGpt.limits,
              {
                id: "openai-codex:secondary",
                label: "7 days",
                scope: { shared: true },
                amount: { unit: "unknown" },
                status: "unknown",
              },
            ],
          },
        ],
      },
      accounts,
      models,
      checkedAt: CHECKED_AT,
    });
    assert.deepStrictEqual(
      limits.windows.map(({ status, usedPercent }) => ({ status, usedPercent })),
      [{ status: "unknown", usedPercent: 33 }],
    );
  });

  it("never widens an unmatched model-scoped limit to provider-wide when models are absent", () => {
    const limits = scientAgentUsageLimits({
      output: {
        reports: [
          {
            provider: "anthropic",
            limits: [
              {
                id: "anthropic:7d:fable",
                label: "Claude 7 Day (Fable)",
                window: { id: "7d", label: "7 Day", durationMs: 604_800_000, resetsAt: RESET_MS },
                amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
                status: "exhausted",
              },
            ],
          },
        ],
      },
      accounts,
      checkedAt: CHECKED_AT,
    });
    assert.deepStrictEqual(limits.windows[0]?.modelIds, []);
  });
});

describe("readScientAgentUsageLimits", () => {
  it.effect("asks the agent only once an account is signed in, and keeps old bars on failure", () =>
    Effect.gen(function* () {
      let runs = 0;
      const failing = () => {
        runs += 1;
        return Effect.fail({ message: "usage failed" });
      };
      const signedOut = accounts.map((account) => ({ ...account, connected: false }));
      assert.isUndefined(yield* readScientAgentUsageLimits(failing, signedOut));
      assert.strictEqual(runs, 0);
      const failed = yield* readScientAgentUsageLimits(failing, accounts);
      assert.strictEqual(failed?.unavailable?.reason, "probeFailed");
      const read = yield* readScientAgentUsageLimits(
        () => Effect.succeed(JSON.stringify({ generatedAt: 1, reports: [chatGpt], capacity: {} })),
        accounts,
      );
      assert.deepStrictEqual(
        read?.windows.map((window) => window.label),
        ["ChatGPT · 7 days"],
      );
    }),
  );
});

describe("scientAgentUsageReader", () => {
  it("counts the agent's conversations as Scient Agent's, apart from Pi's", () => {
    if (scientAgentUsageReader.kind !== "transcripts") throw new Error("transcripts reader");
    const format = scientAgentUsageReader.format;
    const state = format.state!.initial();
    format.parseLine(JSON.stringify({ type: "session", id: "s1" }), state);
    const [record] = format.parseLine(
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-11-13T10:00:00.000Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-6-luna",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } },
        },
      }),
      state,
    );
    assert.strictEqual(record?.provider, "scient");
    assert.isTrue(record?.dedupeKey?.startsWith("scient:"));
  });

  it("counts the agent's calls outside the conversation, such as prompt predictions", () => {
    if (scientAgentUsageReader.kind !== "transcripts") throw new Error("transcripts reader");
    const format = scientAgentUsageReader.format;
    const state = format.state!.initial();
    const [record] = format.parseLine(
      JSON.stringify({
        type: "model_usage",
        id: "u1",
        timestamp: "2026-11-16T10:00:00.000Z",
        purpose: "composer-prediction",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-6-luna",
        usage: { input: 900, output: 12, cacheRead: 80_000, cacheWrite: 0 },
        stopReason: "stop",
      }),
      state,
    );
    assert.deepInclude(record, { provider: "scient", model: "openai-codex/gpt-6-luna" });
    assert.strictEqual(record?.totals.cachedInputTokens, 80_000);
  });

  it("re-reads a scan cached before side calls were counted, keeping its records", () => {
    if (scientAgentUsageReader.kind !== "transcripts") throw new Error("transcripts reader");
    const format = scientAgentUsageReader.format;
    const entry = (state: unknown): CachedFile => ({
      size: 10,
      mtimeMs: 100,
      provider: "scient",
      records: [],
      tailRecords: [],
      malformedRecords: [],
      position: { resumeOffset: 10, guardLength: 4, guardHash: 1, state },
    });
    const saved = JSON.parse(
      [
        ...makeScanCacheWriter()(
          new Map([
            ["/old.jsonl", entry({ sessionId: "s1" })],
            ["/current.jsonl", entry(format.state!.initial())],
          ]),
          {},
        ),
      ].join(""),
    );
    const restored = decodeScanCache(saved, new Map([["scient", format]]));
    expect(restored.get("/old.jsonl")).toMatchObject({
      size: -1,
      position: { resumeOffset: 0, state: null },
    });
    expect(restored.get("/current.jsonl")).toEqual(entry(format.state!.initial()));
  });
});
