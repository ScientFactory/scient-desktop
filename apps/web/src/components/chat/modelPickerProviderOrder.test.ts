import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";

import {
  adjacentModelPickerProvider,
  prioritizeActiveProviderInstance,
} from "./modelPickerProviderOrder";
const entries = ["codex", "claudeAgent", "antigravity", "opencode"].map((instanceId) => ({
  instanceId: ProviderInstanceId.make(instanceId),
}));
function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: {
        status: "authenticated",
      },
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
describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "codex");
  const claude = entry("ready", "claudeAgent");
  const unavailable = entry("error");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };
  // regression: 4e07b49b73 fix(providers): restore composer installation and account setup
  it("includes setup providers in the same navigation order as the rail", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        setupAvailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        setupAvailableInstanceIds: new Set([unavailable.instanceId]),
        disabledInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(claude.instanceId);
  });
});
