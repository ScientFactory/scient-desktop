import { describe, expect, it } from "vite-plus/test";

import { compareProviderDriverKinds } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("provider display order", () => {
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
