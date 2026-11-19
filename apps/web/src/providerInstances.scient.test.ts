import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerInstanceEntriesFor } from "./providerInstances";

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

describe("providerInstanceEntriesFor", () => {
  it("uses canonical provider order and keeps custom instances beneath their default", () => {
    const providers = [
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
    ];
    const settings = { providerInstances: {}, projectSettingsOverrides: {} };

    expect(
      providerInstanceEntriesFor(providers, settings, null).map((entry) => entry.instanceId),
    ).toEqual([
      "codex",
      "claudeAgent",
      "antigravity",
      "antigravity_work",
      "antigravity_personal",
      "cursor",
    ]);
  });
});
