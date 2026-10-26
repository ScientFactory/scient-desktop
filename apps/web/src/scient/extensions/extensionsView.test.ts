import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type DiscoverEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  audienceReaches,
  audienceSupport,
  collectProviderExtensionGroups,
  preferCuratedStoreEntries,
  providerExtensionAudience,
} from "./extensionsView";

const provider = (driver: string, id = driver) =>
  ({
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(id),
  }) as ServerProvider;
const claude = provider("claudeAgent");
const scient = { ...provider("scient"), version: "0.1.3", usesClaudePlugins: true };
const codex = provider("codex");
const plugin = { id: "test", name: "test", enabled: true, source: "local" as const };

describe("extension audiences", () => {
  it("keeps account apps with their owning instance and explains other agents", () => {
    const audience = providerExtensionAudience(codex, { ...plugin, source: "remote" });
    expect(audienceReaches(audience, codex)).toBe(true);
    expect(audienceReaches(audience, provider("codex", "second"))).toBe(false);
    expect(audienceSupport(audience, [codex, claude], [])[1]).toMatchObject({
      status: "unsupported",
      reason: "Uses Codex's own ChatGPT account",
    });
    expect(
      providerExtensionAudience(claude, { name: "mail", status: "needs-auth", scope: "claudeai" })
        .layer,
    ).toBe("agent");
  });
  it("shows shared plugins under the Scient filter while hiding Claude account connectors", () => {
    const groups = collectProviderExtensionGroups(
      [
        {
          ...claude,
          plugins: [plugin],
          mcpServers: [{ name: "mail", status: "needs-auth", scope: "claudeai" }],
        },
        scient,
      ],
      scient.instanceId,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.plugins).toHaveLength(1);
    expect(groups[0]?.mcpServers).toEqual([]);
    expect(audienceReaches(providerExtensionAudience(claude, plugin), codex)).toBe(false);
  });
  it("prefers explicit curated aliases without hiding unrelated store entries", () => {
    const curated = [{ agentStores: { codex: "notion" } }] as DiscoverEntry[];
    expect(preferCuratedStoreEntries([{ name: "notion" }, { name: "gmail" }], curated)).toEqual([
      { name: "gmail" },
    ]);
  });
});

it("keeps standalone Claude MCP servers private and retains a Scient-owned shared plugin when source sharing is off", () => {
  const manual = providerExtensionAudience(claude, {
    name: "private",
    scope: "user",
    status: "unknown",
  });
  expect(manual.layer).toBe("agent");
  expect(audienceReaches(manual, scient)).toBe(false);
  const own = { ...scient, usesClaudePlugins: false, version: "0.1.2" };
  const shared = providerExtensionAudience(own, { ...plugin, marketplace: "official" });
  expect(audienceReaches(shared, own)).toBe(true);
  expect(audienceReaches(providerExtensionAudience(claude, plugin), own)).toBe(false);
});
