import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { providerClients } from "./providerDriverMeta";
import { deriveProviderSettingsFields } from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers (Scient)", () => {
  // regression: 511bc318c4 fix(alignment): preserve Scient presentation and guarded reload
  it("keeps OpenCode server help independent of upstream product branding", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl?.description).toBe("Leave blank to start the server when needed.");
  });
});
