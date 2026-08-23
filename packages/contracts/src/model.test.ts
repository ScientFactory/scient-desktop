import { describe, expect, it } from "vite-plus/test";

import { compareProviderDriverKinds, PROVIDER_DISPLAY_ORDER } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("provider display order", () => {
  it("pins the canonical first-party order", () => {
    expect(PROVIDER_DISPLAY_ORDER).toEqual([
      "codex",
      "claudeAgent",
      "antigravity",
      "opencode",
      "droid",
      "cursor",
      "grok",
    ]);
  });

  it("places open plugin drivers after first-party providers alphabetically", () => {
    const drivers = ["zeta", "cursor", "alpha", "antigravity"].map((driver) =>
      ProviderDriverKind.make(driver),
    );

    expect(drivers.toSorted(compareProviderDriverKinds)).toEqual([
      "antigravity",
      "cursor",
      "alpha",
      "zeta",
    ]);
  });
});
