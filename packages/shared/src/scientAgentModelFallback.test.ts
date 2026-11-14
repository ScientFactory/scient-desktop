import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scientAgentAlternativeModel } from "./scientAgentModelFallback.ts";
import { resolveNewThreadModelSelection } from "./usageLimits.ts";

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
    ).toBe("openai-codex/gpt-6-luna");
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
      model: "openai-codex/gpt-6-luna",
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
