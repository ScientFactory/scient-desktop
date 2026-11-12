import { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";

describe("resolveDefaultModelSettingsPresentation", () => {
  // regression: 67ab5e432f fix(settings): keep the default model's reasoning effort as chosen (#394)
  it("does not call a saved default unavailable before any provider is reported", () => {
    const saved = createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-8", [
      { id: "effort", value: "high" },
    ]);
    expect(
      resolveDefaultModelSettingsPresentation({
        entries: [],
        providers: [],
        settings: { ...DEFAULT_UNIFIED_SETTINGS, defaultModelSelection: saved },
        projectId: null,
      }),
    ).toEqual({ selection: saved, providerNote: null });
  });
});
