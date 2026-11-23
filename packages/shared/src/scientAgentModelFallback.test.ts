import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scientAgentAlternativeModel } from "./scientAgentModelFallback.ts";
import {
  collectLimitAccounts,
  collectProviderUsageLimits,
  evaluateRouteQuota,
  resolveNewThreadModelSelection,
  resolveUsageLimitFallback,
} from "./usageLimits.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const account = (
  id: string,
  overrides: Partial<ProviderConnectionAccount> = {},
): ProviderConnectionAccount => ({
  id,
  name: id,
  kind: "account",
  connected: true,
  canDisconnect: true,
  ...overrides,
});
const model = (slug: string, isCustom = false) => ({
  slug,
  name: slug.split("/")[1]!,
  isCustom,
  capabilities: null,
});

function scientAgent(
  accounts: ReadonlyArray<ProviderConnectionAccount>,
  exhaustedProvider = "google-antigravity",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("scient"),
    driver: ProviderDriverKind.make("scient"),
    enabled: true,
    installed: true,
    version: "0.1.6",
    status: "ready",
    auth: { status: "unknown", required: false },
    checkedAt: "2026-11-13T00:00:00.000Z",
    models: [
      model("google-antigravity/gemini-3.8-flash"),
      model("ollama/qwen", true),
      model("deepseek/deepseek-v4"),
      model("openai-codex/gpt-6-luna"),
      model("openai-codex/gpt-6.1-sol"),
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-13T11:59:00.000Z",
      windows: [
        {
          id: `${exhaustedProvider}:5h`,
          kind: "session",
          label: "Google · 5 hours",
          providerIds: [exhaustedProvider],
          status: "exhausted",
          fetchedAt: "2026-11-13T11:59:00.000Z",
          usedPercent: 100,
          resetsAt: "2026-11-13T15:00:00.000Z",
        },
      ],
    },
    connection: { methods: [], canDisconnect: false, operation: null, accounts },
  };
}

const exhausted = (provider: ServerProvider) => (slug: string) =>
  provider.usageLimits?.windows.some(
    (window) => window.usedPercent >= 100 && window.providerIds?.includes(slug.split("/")[0]!),
  ) === true;

describe("scientAgentAlternativeModel", () => {
  it("offers another signed-in account's model, never a custom model or a paid API key", () => {
    const provider = scientAgent([
      account("google-antigravity"),
      account("deepseek", { kind: "key" }),
      account("openai-codex"),
    ]);
    expect(
      scientAgentAlternativeModel(
        provider,
        "google-antigravity/gemini-3.8-flash",
        exhausted(provider),
      )?.slug,
    ).toBe("openai-codex/gpt-6.1-sol");
  });

  it("offers nothing when the other account is signed out or out of quota too", () => {
    const signedOut = scientAgent([
      account("google-antigravity"),
      account("openai-codex", { connected: false }),
    ]);
    expect(
      scientAgentAlternativeModel(
        signedOut,
        "google-antigravity/gemini-3.8-flash",
        exhausted(signedOut),
      ),
    ).toBeUndefined();
    const provider = scientAgent([account("google-antigravity"), account("openai-codex")]);
    expect(
      scientAgentAlternativeModel(provider, "google-antigravity/gemini-3.8-flash", () => true),
    ).toBeUndefined();
  });
});

describe("resolveNewThreadModelSelection for Scient Agent", () => {
  it("starts a new thread on another account's model only when blocked and replacement has quota", () => {
    const base = scientAgent([account("google-antigravity"), account("openai-codex")]);
    const withHealthyCodex: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: base.usageLimits!.checkedAt,
        windows: [
          ...base.usageLimits!.windows,
          {
            id: "openai-codex:primary",
            kind: "session",
            label: "ChatGPT · 5 hours",
            providerIds: ["openai-codex"],
            accountId: "openai-codex:acct",
            status: "ok",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 20,
            resetsAt: "2026-11-13T16:00:00.000Z",
          },
        ],
      },
    };
    const resolved = resolveNewThreadModelSelection({
      defaultSelection: {
        instanceId: withHealthyCodex.instanceId,
        model: "google-antigravity/gemini-3.8-flash",
      },
      fallbackSelection: null,
      providers: [withHealthyCodex],
      now: NOW,
    });
    expect(resolved.selection).toEqual({
      instanceId: withHealthyCodex.instanceId,
      model: "openai-codex/gpt-6.1-sol",
    });
    expect(resolved.fallback?.resetsAt).toBe("2026-11-13T15:00:00.000Z");
    expect(resolved.fallback?.limitLabel).toBe("Google · 5 hours");

    // Without credible quota evidence for Codex, automatic fallback does not switch blindly.
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: {
          instanceId: base.instanceId,
          model: "google-antigravity/gemini-3.8-flash",
        },
        fallbackSelection: null,
        providers: [base],
        now: NOW,
      }),
    ).toEqual({
      selection: {
        instanceId: base.instanceId,
        model: "google-antigravity/gemini-3.8-flash",
      },
      fallback: null,
    });

    // The agent's own choice stands while its account has quota left.
    const healthy = scientAgent([account("google-antigravity"), account("openai-codex")], "none");
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: {
          instanceId: healthy.instanceId,
          model: "google-antigravity/gemini-3.8-flash",
        },
        fallbackSelection: null,
        providers: [healthy],
        now: NOW,
      }).fallback,
    ).toBeNull();
  });

  it("retains Opus when shared Claude has quota, Fable is exhausted, and Codex has no reading", () => {
    const opus = "anthropic/claude-opus-5-5";
    const fable = "anthropic/claude-fable-5-1";
    const sol = "openai-codex/gpt-6.1-sol";
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "anthropic:5h",
        kind: "session",
        label: "Claude · 5 Hour",
        providerIds: ["anthropic"],
        accountId: "anthropic:acct-1",
        status: "ok",
        fetchedAt: "2026-11-13T11:58:00.000Z",
        usedPercent: 40,
        resetsAt: "2026-11-13T15:00:00.000Z",
      },
      {
        id: "anthropic:7d:fable",
        kind: "weekly",
        label: "Claude · 7 Day (Fable)",
        providerIds: ["anthropic"],
        modelIds: [fable],
        accountId: "anthropic:acct-1",
        status: "exhausted",
        fetchedAt: "2026-11-13T11:58:00.000Z",
        usedPercent: 100,
        resetsAt: "2026-11-18T00:00:00.000Z",
      },
    ];
    const provider: ServerProvider = {
      ...scientAgent([account("anthropic"), account("openai-codex")]),
      models: [model(opus), model(fable), model(sol)],
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows,
      },
    };

    expect(
      resolveNewThreadModelSelection({
        defaultSelection: { instanceId: provider.instanceId, model: opus },
        fallbackSelection: null,
        providers: [provider],
        now: NOW,
      }),
    ).toEqual({
      selection: { instanceId: provider.instanceId, model: opus },
      fallback: null,
    });

    // Even when Fable itself is selected, absent Codex reading prevents automatic fallback.
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: { instanceId: provider.instanceId, model: fable },
        fallbackSelection: null,
        providers: [provider],
        now: NOW,
      }).fallback,
    ).toBeNull();

    // Once Codex reports credible remaining quota, Fable switches to Codex with the Fable limit label,
    // while Opus still stays on Opus.
    const withCodex: ServerProvider = {
      ...provider,
      usageLimits: {
        ...provider.usageLimits!,
        windows: [
          ...windows,
          {
            id: "openai-codex:primary",
            kind: "session",
            label: "ChatGPT · 5 hours",
            providerIds: ["openai-codex"],
            accountId: "openai-codex:acct-1",
            status: "ok",
            fetchedAt: "2026-11-13T11:58:00.000Z",
            usedPercent: 25,
            resetsAt: "2026-11-13T16:00:00.000Z",
          },
        ],
      },
    };
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: { instanceId: withCodex.instanceId, model: opus },
        fallbackSelection: null,
        providers: [withCodex],
        now: NOW,
      }).fallback,
    ).toBeNull();

    const fableResolved = resolveNewThreadModelSelection({
      defaultSelection: { instanceId: withCodex.instanceId, model: fable },
      fallbackSelection: null,
      providers: [withCodex],
      now: NOW,
    });
    expect(fableResolved.selection).toEqual({ instanceId: withCodex.instanceId, model: sol });
    expect(fableResolved.fallback?.limitLabel).toBe("Claude · 7 Day (Fable)");
    expect(fableResolved.fallback?.resetsAt).toBe("2026-11-18T00:00:00.000Z");
  });

  it("respects 100% warnings, multi-account pools, unknown siblings, and stale/expired readings", () => {
    const opus = "anthropic/claude-opus-5-5";
    const sol = "openai-codex/gpt-6.1-sol";
    const base = {
      ...scientAgent([account("anthropic"), account("openai-codex")]),
      models: [model(opus), model(sol)],
    };

    // 100% warning is NOT blocked and counts as available.
    const warningCodex: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: [
          {
            id: "openai-codex:primary",
            kind: "session",
            label: "ChatGPT · 5 hours",
            providerIds: ["openai-codex"],
            accountId: "openai-codex:1",
            status: "warning",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 100,
            resetsAt: "2026-11-13T15:00:00.000Z",
          },
        ],
      },
    };
    expect(evaluateRouteQuota(warningCodex, NOW, sol)).toEqual({ state: "available" });

    const codexWindow = warningCodex.usageLimits!.windows[0]!;
    for (const otherWindow of [
      { ...codexWindow, id: "secondary", status: "unknown" as const },
      { ...codexWindow, id: "secondary", fetchedAt: "2026-11-13T11:30:00.000Z" },
      { ...codexWindow, id: "secondary", resetsAt: "2026-11-13T11:59:00.000Z" },
    ]) {
      expect(
        evaluateRouteQuota(
          {
            ...base,
            usageLimits: {
              ...warningCodex.usageLimits!,
              windows: [codexWindow, otherWindow],
            },
          },
          NOW,
          sol,
        ),
      ).toEqual({ state: "unknown" });
    }
    expect(
      evaluateRouteQuota(
        {
          ...base,
          usageLimits: {
            ...warningCodex.usageLimits!,
            windows: [
              { ...codexWindow, status: undefined, fetchedAt: undefined, usedPercent: 100 },
            ],
          },
        },
        NOW,
        sol,
      ),
    ).toEqual({ state: "unknown" });

    // Multi-account pool: one exhausted + one healthy -> route available.
    const twoAccountsHealthy: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: [
          {
            id: "anthropic:5h",
            kind: "session",
            label: "Claude (a@example.invalid) · 5 Hour",
            providerIds: ["anthropic"],
            accountId: "anthropic:a",
            status: "exhausted",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 100,
            resetsAt: "2026-11-13T15:00:00.000Z",
          },
          {
            id: "anthropic:5h#2",
            kind: "session",
            label: "Claude (b@example.invalid) · 5 Hour",
            providerIds: ["anthropic"],
            accountId: "anthropic:b",
            status: "ok",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 20,
            resetsAt: "2026-11-13T16:00:00.000Z",
          },
        ],
      },
    };
    expect(evaluateRouteQuota(twoAccountsHealthy, NOW, opus)).toEqual({ state: "available" });

    // One exhausted + one unreported sibling -> unknown (not confirmed blocked).
    const unknownSibling: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        unknownProviderIds: ["anthropic"],
        windows: [twoAccountsHealthy.usageLimits!.windows[0]!],
      },
    };
    expect(evaluateRouteQuota(unknownSibling, NOW, opus)).toEqual({ state: "unknown" });

    const outsideModel = {
      ...twoAccountsHealthy.usageLimits!.windows[1]!,
      modelIds: ["anthropic/claude-fable-5-1"],
    };
    expect(
      evaluateRouteQuota(
        {
          ...base,
          usageLimits: {
            ...twoAccountsHealthy.usageLimits!,
            windows: [twoAccountsHealthy.usageLimits!.windows[0]!, outsideModel],
          },
        },
        NOW,
        opus,
      ),
    ).toEqual({ state: "unknown" });

    // Both accounts exhausted -> blocked, unblocks at earliest reset.
    const bothExhausted: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: [
          twoAccountsHealthy.usageLimits!.windows[0]!,
          {
            ...twoAccountsHealthy.usageLimits!.windows[1]!,
            status: "exhausted",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 100,
            resetsAt: "2026-11-13T13:30:00.000Z",
          },
        ],
      },
    };
    expect(evaluateRouteQuota(bothExhausted, NOW, opus)).toMatchObject({
      state: "blocked",
      resetsAt: "2026-11-13T13:30:00.000Z",
    });

    // Stale cached reading (fetchedAt 20 min before checkedAt) -> unknown.
    const staleCached: ServerProvider = {
      ...base,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: [
          {
            ...twoAccountsHealthy.usageLimits!.windows[0]!,
            fetchedAt: "2026-11-13T11:30:00.000Z",
          },
        ],
      },
    };
    expect(evaluateRouteQuota(staleCached, NOW, opus)).toEqual({ state: "unknown" });
  });

  it("scopes Scient Agent composer /usage-limits to the selected route while Usage -> Limits stays aggregate", () => {
    const opus = "anthropic/claude-opus-5-5";
    const fable = "anthropic/claude-fable-5-1";
    const sol = "openai-codex/gpt-6.1-sol";
    const provider: ServerProvider = {
      ...scientAgent([account("anthropic"), account("openai-codex")]),
      models: [model(opus), model(fable), model(sol)],
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: [
          {
            id: "anthropic:5h",
            kind: "session",
            label: "Claude · 5 Hour",
            providerIds: ["anthropic"],
            status: "ok",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 40,
          },
          {
            id: "anthropic:7d:fable",
            kind: "weekly",
            label: "Claude · 7 Day (Fable)",
            providerIds: ["anthropic"],
            modelIds: [fable],
            status: "exhausted",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 100,
          },
          {
            id: "openai-codex:primary",
            kind: "session",
            label: "ChatGPT · 5 hours",
            providerIds: ["openai-codex"],
            status: "ok",
            fetchedAt: "2026-11-13T11:59:00.000Z",
            usedPercent: 25,
          },
        ],
      },
    };

    const gptReport = collectProviderUsageLimits(provider.instanceId, [provider], [], NOW, sol);
    expect(gptReport?.accounts[0]?.limits.windows.map((window) => window.id)).toEqual([
      "openai-codex:primary",
    ]);

    const opusReport = collectProviderUsageLimits(provider.instanceId, [provider], [], NOW, opus);
    expect(opusReport?.accounts[0]?.limits.windows.map((window) => window.id)).toEqual([
      "anthropic:5h",
    ]);

    const fableReport = collectProviderUsageLimits(provider.instanceId, [provider], [], NOW, fable);
    expect(fableReport?.accounts[0]?.limits.windows.map((window) => window.id)).toEqual([
      "anthropic:5h",
      "anthropic:7d:fable",
    ]);

    // Absent Codex reading on a GPT route shows no unrelated Claude/Fable windows.
    const noCodex: ServerProvider = {
      ...provider,
      usageLimits: {
        checkedAt: "2026-11-13T11:59:00.000Z",
        windows: provider.usageLimits!.windows.filter(
          (window) => window.providerIds?.[0] !== "openai-codex",
        ),
      },
    };
    const absentGptReport = collectProviderUsageLimits(noCodex.instanceId, [noCodex], [], NOW, sol);
    expect(absentGptReport?.accounts[0]?.limits.windows).toEqual([]);

    // Global Usage -> Limits remains aggregate across all accounts and scoped windows.
    const aggregate = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("local"),
          { entry: { target: { label: "Local" } }, serverConfig: { providers: [provider] } },
        ],
      ]),
    );
    expect(aggregate[0]?.limits.windows.map((window) => window.id)).toEqual([
      "anthropic:5h",
      "anthropic:7d:fable",
      "openai-codex:primary",
    ]);
  });
});

describe("subscription fallback policy", () => {
  const currentModel = "anthropic/claude-opus-5-5";
  const sol = "openai-codex/gpt-6.1-sol";
  const wonder = "muse-code/muse-wonder-full-1.0";
  const makeAgent = () => ({
    ...scientAgent(
      [account("anthropic"), account("openai-codex"), account("muse-code"), account("openrouter")],
      "anthropic",
    ),
    models: [
      model("openrouter/first-alphabetically"),
      model("openai-codex/gpt-5.6-luna"),
      model(sol),
      model(currentModel),
      model(wonder),
    ],
  });
  const resolve = (agent: ServerProvider, overrides = {}) =>
    resolveUsageLimitFallback({
      currentSelection: { instanceId: agent.instanceId, model: currentModel },
      fallbackSelection: null,
      providers: [agent],
      now: NOW,
      ...overrides,
    });

  it("honors the explicit fallback before another subscription inside Scient Agent", () => {
    const agent = makeAgent();
    const native: ServerProvider = {
      ...agent,
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      auth: { status: "authenticated", type: "chatgpt" },
      models: [model("gpt-6.1-sol")],
      usageLimits: {
        checkedAt: agent.usageLimits!.checkedAt,
        windows: [{ id: "primary", kind: "session", label: "5 Hour", usedPercent: 10 }],
      },
    };
    const configured = {
      instanceId: native.instanceId,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const input = {
      defaultSelection: { instanceId: agent.instanceId, model: currentModel },
      fallbackSelection: configured,
      providers: [agent, native],
      now: NOW,
    };
    expect(resolveNewThreadModelSelection(input).selection).toEqual(configured);
    expect(
      resolveUsageLimitFallback({ ...input, currentSelection: input.defaultSelection }),
    ).toEqual(configured);
    for (const auth of [
      { status: "authenticated" as const, type: "apiKey" },
      { status: "authenticated" as const, type: "chatgpt", endpoint: "https://metered.example" },
    ]) {
      expect(
        resolveUsageLimitFallback({
          ...input,
          currentSelection: input.defaultSelection,
          providers: [agent, { ...native, auth, usageLimits: undefined }],
        }),
      ).toEqual(configured);
    }
    expect(
      resolveNewThreadModelSelection({
        ...input,
        explicitSelection: input.defaultSelection,
      }).selection,
    ).toEqual(input.defaultSelection);
  });

  it.each([
    { driver: "cursor", model: "grok-4.7" },
    { driver: "claudeAgent", model: "claude-sonnet-5-5" },
    { driver: "antigravity", model: "gemini-4-hydrogen" },
    { driver: "muse", model: "muse-wonder-full-1.0" },
  ])(
    "offers a configured $driver fallback without telemetry only during explicit recovery",
    (candidate) => {
      const agent = makeAgent();
      const native: ServerProvider = {
        ...agent,
        instanceId: ProviderInstanceId.make("configured"),
        driver: ProviderDriverKind.make(candidate.driver),
        auth: { status: "authenticated" },
        models: [model(candidate.model)],
        usageLimits: undefined,
      };
      const configured = { instanceId: native.instanceId, model: candidate.model };
      const input = {
        defaultSelection: { instanceId: agent.instanceId, model: currentModel },
        fallbackSelection: configured,
        providers: [agent, native],
        now: NOW,
      };
      expect(resolveNewThreadModelSelection(input).selection).toEqual(input.defaultSelection);
      expect(
        resolveUsageLimitFallback({ ...input, currentSelection: input.defaultSelection }),
      ).toEqual(configured);
      expect(
        resolveUsageLimitFallback({
          ...input,
          currentSelection: input.defaultSelection,
          providers: [agent, { ...native, models: [{ ...native.models[0]!, isCustom: true }] }],
        }),
      ).toEqual(configured);
    },
  );

  it.each(["gemini-3.8-flash", "antigravity-default"])(
    "keeps a saved fallback hidden only by defaults: %s",
    (savedModel) => {
      const agent = makeAgent();
      const slug = "gemini-3.8-flash";
      const native: ServerProvider = {
        ...agent,
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        models: [{ ...model(slug), aliases: ["antigravity-default"] }],
        usageLimits: undefined,
      };
      const configured = { instanceId: native.instanceId, model: savedModel };
      const input = {
        currentSelection: { instanceId: agent.instanceId, model: currentModel },
        fallbackSelection: configured,
        providers: [agent, native],
        now: NOW,
      };
      expect(resolveUsageLimitFallback(input)).toEqual(configured);
      expect(
        resolveUsageLimitFallback({
          ...input,
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            providerModelPreferences: {
              [native.instanceId]: { hiddenModels: [slug], modelOrder: [] },
            },
          },
        }),
      ).toEqual({ instanceId: agent.instanceId, model: sol });
      expect(
        resolveUsageLimitFallback({
          ...input,
          providers: [
            agent,
            {
              ...native,
              usageLimits: {
                checkedAt: agent.usageLimits!.checkedAt,
                windows: [
                  {
                    id: "gemini-pool",
                    kind: "session",
                    label: "Gemini",
                    usedPercent: 100,
                    modelIds: [slug],
                  },
                ],
              },
            },
          ],
        }),
      ).toEqual({ instanceId: agent.instanceId, model: sol });
    },
  );

  it("skips hidden and unavailable preferred models without reviving an old catalog entry", () => {
    const agent = makeAgent();
    expect(
      resolve(agent, {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerModelPreferences: {
            [agent.instanceId]: { hiddenModels: [sol], modelOrder: [] },
          },
        },
      }),
    ).toEqual({ instanceId: agent.instanceId, model: wonder });
    const unavailable = {
      ...agent,
      models: agent.models.map((entry) =>
        entry.slug === sol ? { ...entry, unavailableReason: "Not in this plan" } : entry,
      ),
    };
    expect(resolve(unavailable)).toEqual({ instanceId: agent.instanceId, model: wonder });
    expect(
      resolve({
        ...agent,
        models: agent.models.filter((entry) => entry.slug !== sol && entry.slug !== wonder),
      }),
    ).toBeUndefined();
  });

  it("does not use OAuth billing routes or escape an exhausted subscription through an alias", () => {
    const agent = makeAgent();
    const aliases = {
      ...agent,
      connection: {
        ...agent.connection!,
        accounts: [
          account("anthropic"),
          account("openai-codex"),
          account("openai-codex-device", { sameAccountAs: "openai-codex" }),
          account("openrouter"),
        ],
      },
    };
    expect(
      resolve(aliases, {
        currentSelection: {
          instanceId: agent.instanceId,
          model: "openai-codex-device/gpt-6.1-sol",
        },
      }),
    ).toBeUndefined();
    expect(
      resolve({
        ...agent,
        connection: {
          ...agent.connection!,
          accounts: [account("anthropic"), account("openrouter")],
        },
      }),
    ).toBeUndefined();
  });

  it("rejects disabled instances and exhausted preferred pools, preserving healthy defaults", () => {
    const agent = makeAgent();
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [agent.instanceId]: { driver: agent.driver, enabled: false, config: {} },
      },
    };
    expect(resolve(agent, { settings })).toBeUndefined();
    expect(
      resolve({
        ...agent,
        usageLimits: {
          checkedAt: agent.usageLimits!.checkedAt,
          windows: [
            ...agent.usageLimits!.windows,
            {
              id: "openai-week",
              kind: "weekly",
              label: "OpenAI",
              providerIds: ["openai-codex"],
              status: "exhausted",
              fetchedAt: "2026-11-13T11:59:00.000Z",
              usedPercent: 100,
              resetsAt: "2026-11-14T00:00:00Z",
            },
          ],
        },
      }),
    ).toEqual({ instanceId: agent.instanceId, model: wonder });
    const healthy = { ...agent, usageLimits: undefined };
    expect(
      resolveNewThreadModelSelection({
        defaultSelection: { instanceId: agent.instanceId, model: currentModel },
        fallbackSelection: { instanceId: agent.instanceId, model: sol },
        providers: [healthy],
        now: NOW,
      }).selection,
    ).toEqual({ instanceId: agent.instanceId, model: currentModel });
  });
});
