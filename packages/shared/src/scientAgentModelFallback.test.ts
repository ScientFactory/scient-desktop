import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scientAgentAlternativeModel } from "./scientAgentModelFallback.ts";
import { resolveNewThreadModelSelection, resolveUsageLimitFallback } from "./usageLimits.ts";

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
  it("starts a new thread on another account's model while the default's account is out of quota", () => {
    const provider = scientAgent([account("google-antigravity"), account("openai-codex")]);
    const resolved = resolveNewThreadModelSelection({
      defaultSelection: {
        instanceId: provider.instanceId,
        model: "google-antigravity/gemini-3.8-flash",
      },
      fallbackSelection: null,
      providers: [provider],
      now: NOW,
    });
    expect(resolved.selection).toEqual({
      instanceId: provider.instanceId,
      model: "openai-codex/gpt-6.1-sol",
    });
    expect(resolved.fallback?.resetsAt).toBe("2026-11-13T15:00:00.000Z");

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
      usageLimits: undefined,
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
          providers: [agent, { ...native, auth }],
        }),
      ).toEqual({ instanceId: agent.instanceId, model: sol });
    }
    expect(
      resolveNewThreadModelSelection({
        ...input,
        explicitSelection: input.defaultSelection,
      }).selection,
    ).toEqual(input.defaultSelection);
  });

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
          checkedAt: agent.checkedAt,
          windows: [
            ...agent.usageLimits!.windows,
            {
              id: "openai-week",
              kind: "weekly",
              label: "OpenAI",
              providerIds: ["openai-codex"],
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
