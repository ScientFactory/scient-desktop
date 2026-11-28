import { describe, expect, it } from "vite-plus/test";
import { AccountId, EnvironmentId, type AccountSummary } from "@t3tools/contracts";

import { keyUseLabel, keyUseLink, referencedKeyUses } from "./keyUses";

describe("referencedKeyUses", () => {
  it("names every holder the key editor and the list show, each with its own page", () => {
    const shared = AccountId.make("acc_shared01");
    const kept = AccountId.make("acc_kept0001");
    const uses = referencedKeyUses({
      accounts: [
        {
          accountId: kept,
          details: {
            kind: "api-key",
            sites: [],
            auth: { type: "bearer" },
            privateTo: { kind: "text-generator", id: "titles", name: "Titles" },
          },
        } as never as AccountSummary,
      ],
      keyLinks: [{ accountId: shared, instanceId: "codex", variable: "OPENAI_API_KEY" }],
      instances: {
        codex: { driver: "codex", environment: [{ name: "OPENAI_API_KEY", sensitive: true }] },
      },
      driverName: () => "Codex",
      textGenerators: { titles: { label: "Titles", apiKey: "typed" } },
      connectors: [
        {
          connectorId: "con_a" as never,
          displayName: "Search A",
          auth: { type: "credential", strategy: "bearer", storage: "bound", accountId: shared },
        },
        {
          connectorId: "con_b" as never,
          displayName: "Search B",
          auth: { type: "credential", strategy: "bearer", storage: "bound", accountId: shared },
        },
      ],
    });
    expect(uses.get(shared)?.map((use) => keyUseLabel(use))).toEqual([
      "Codex · OPENAI_API_KEY",
      "Extensions · Search A",
      "Extensions · Search B",
    ]);
    expect(uses.get(shared)?.flatMap((use) => use.connectorId ?? [])).toEqual(["con_a", "con_b"]);
    expect(uses.get(kept)?.map((use) => keyUseLabel(use))).toEqual(["Text generation · Titles"]);
    // Each use links to its own item, not only its page, on the computer that holds the key.
    const machine = EnvironmentId.make("synthetic-second-computer");
    const link = (use: Parameters<typeof keyUseLink>[0]) => keyUseLink(use, machine);
    expect(uses.get(shared)?.map(link)).toEqual([
      { to: "/settings/providers", search: { machine, instanceId: "codex" } },
      {
        to: "/settings/extensions/item/connector/$connectorId",
        params: { connectorId: "con_a" },
        search: { machine },
      },
      {
        to: "/settings/extensions/item/connector/$connectorId",
        params: { connectorId: "con_b" },
        search: { machine },
      },
    ]);
    expect(uses.get(kept)?.map(link)).toEqual([
      { to: "/settings/providers", search: { machine, instanceId: "titles" } },
    ]);
    const models = referencedKeyUses({
      keyConsumers: [
        { accountId: shared, id: "conn-1", name: "OpenRouter", kind: "custom-model" },
        { accountId: shared, id: "engine-1", name: "Whisper", kind: "transcription" },
      ],
      libraryKeys: { semanticScholar: shared },
    });
    expect(models.get(shared)?.map(link)).toEqual([
      { to: "/settings/custom-models", search: { machine }, hash: "custom-model-conn-1" },
      { to: "/settings/voice", search: { machine }, hash: "voice-engine-engine-1" },
      { to: "/settings/documents", search: { machine }, hash: "library-key-semanticScholar" },
    ]);
  });
});
