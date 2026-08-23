import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prioritizeActiveProviderInstance } from "./modelPickerProviderOrder";

const entries = ["codex", "claudeAgent", "antigravity", "opencode"].map((instanceId) => ({
  instanceId: ProviderInstanceId.make(instanceId),
}));

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
