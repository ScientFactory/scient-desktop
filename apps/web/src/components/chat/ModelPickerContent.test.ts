import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { shouldIncludeModelPickerOption } from "./ModelPickerContent";
import { prioritizeActiveProviderInstance } from "./modelPickerProviderOrder";

const entries = ["codex", "claudeAgent", "antigravity", "opencode"].map((instanceId) => ({
  instanceId: ProviderInstanceId.make(instanceId),
}));

function entry(status: ServerProvider["status"]) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("opencode_work"),
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("prioritizeActiveProviderInstance", () => {
  it("moves the active composer provider ahead of the canonical default order", () => {
    expect(
      prioritizeActiveProviderInstance(entries, ProviderInstanceId.make("antigravity")).map(
        (entry) => entry.instanceId,
      ),
    ).toEqual(["antigravity", "codex", "claudeAgent", "opencode"]);
  });

  it("preserves the canonical order when the active provider is already first or absent", () => {
    expect(prioritizeActiveProviderInstance(entries, ProviderInstanceId.make("codex"))).toBe(
      entries,
    );
    expect(prioritizeActiveProviderInstance(entries, ProviderInstanceId.make("missing"))).toBe(
      entries,
    );
  });
});

describe("shouldIncludeModelPickerOption", () => {
  it.each(["error", "warning"] as const)(
    "keeps only the active synthetic OpenCode row when the provider status is %s",
    (status) => {
      const providerEntry = entry(status);
      const activeInstanceId = ProviderInstanceId.make("opencode_work");
      const activeModel = "openrouter/kimi-k3";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "other/missing", name: "Other missing", isUnavailable: true },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
    },
  );
});
