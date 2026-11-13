import { assert, describe, it } from "@effect/vitest";
import type { ProviderConnectionAccount } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readScientAgentUsageLimits, scientAgentUsageLimits } from "./ScientAgentUsage.ts";

const CHECKED_AT = "2026-11-13T12:00:00.000Z";
const RESET_MS = Date.parse("2026-11-16T09:00:00.000Z");
const accounts: ReadonlyArray<ProviderConnectionAccount> = [
  { id: "openai-codex", name: "ChatGPT", kind: "account", connected: true, canDisconnect: true },
  { id: "anthropic", name: "Claude", kind: "account", connected: true, canDisconnect: true },
];

// The shape `scient-agent usage --json` printed for a ChatGPT account (0.1.5, identities removed).
const chatGpt = {
  provider: "openai-codex",
  fetchedAt: 1,
  metadata: { email: "a@example.invalid", accountId: "acct", planType: "plus" },
  limits: [
    {
      id: "openai-codex:primary",
      label: "7 days",
      scope: { provider: "openai-codex", windowId: "7d", shared: true },
      window: { id: "7d", label: "7 days", durationMs: 604_800_000, resetsAt: RESET_MS },
      amount: { used: 33, limit: 100, usedFraction: 0.33, unit: "percent" },
      status: "ok",
    },
  ],
};

describe("scientAgentUsageLimits", () => {
  it("shows each account's windows under the account's name, for its own models", () => {
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
          usedPercent: 33,
          resetsAt: "2026-11-16T09:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it("tells two accounts of one provider apart and reads every way the agent reports use", () => {
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
              { id: "anthropic:opaque", label: "Credits", amount: { unit: "credits" } },
            ],
          },
        ],
      },
      accounts,
      checkedAt: CHECKED_AT,
    });
    assert.deepStrictEqual(
      limits.windows.map((window) => [window.id, window.kind, window.label, window.usedPercent]),
      [
        ["anthropic:5h", "session", "Claude (one@example.invalid) · 5 hours", 75],
        ["anthropic:5h#2", "session", "Claude (two@example.invalid) · 5 hours", 100],
      ],
    );
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
