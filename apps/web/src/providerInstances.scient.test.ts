import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  resolveDefaultModelSettingsSelection,
  sortProviderInstanceEntries,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("sortProviderInstanceEntries", () => {
  it("uses canonical provider order and keeps custom instances beneath their default", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("cursor"), instanceId: "cursor" }),
      provider({
        provider: ProviderDriverKind.make("antigravity"),
        instanceId: "antigravity_work",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("antigravity"),
        instanceId: "antigravity_personal",
      }),
      provider({ provider: ProviderDriverKind.make("antigravity"), instanceId: "antigravity" }),
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(sortProviderInstanceEntries(entries).map((entry) => entry.instanceId)).toEqual([
      "codex",
      "claudeAgent",
      "antigravity",
      "antigravity_work",
      "antigravity_personal",
      "cursor",
    ]);
  });
});

// regression: 67ab5e432f fix(settings): keep the default model's reasoning
describe("resolveDefaultModelSettingsSelection", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const stored = {
    instanceId: claude,
    model: "claude-opus-4-8",
    options: [{ id: "effort", value: "high" }],
  };
  const codexReady = provider({
    provider: ProviderDriverKind.make("codex"),
    instanceId: "codex",
    models: [model("gpt-5.6", false, true)],
  });

  it("shows a saved default whose provider is available as-is", () => {
    const providers = [
      codexReady,
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8")],
      }),
    ];

    expect(resolveDefaultModelSettingsSelection(providers, stored)).toEqual({
      selection: stored,
      storedUnavailable: false,
    });
  });

  it("keeps a saved default whose provider instance is gone", () => {
    expect(resolveDefaultModelSettingsSelection([codexReady], stored)).toEqual({
      selection: stored,
      storedUnavailable: true,
    });
  });

  it("does not call a saved default unavailable before any provider is reported", () => {
    expect(resolveDefaultModelSettingsSelection([], stored)).toEqual({
      selection: null,
      storedUnavailable: false,
    });
  });

  it("shows the fallback new threads would use when nothing is saved", () => {
    expect(resolveDefaultModelSettingsSelection([codexReady], null)).toEqual({
      selection: { instanceId: "codex", model: "gpt-5.6" },
      storedUnavailable: false,
    });
  });
});
