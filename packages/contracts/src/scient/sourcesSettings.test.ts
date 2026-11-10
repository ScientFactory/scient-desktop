import { describe, expect, it } from "@effect/vitest";

import { usableRegistryContactEmail } from "./sourcesSettings.ts";

describe("usableRegistryContactEmail", () => {
  it("sends only an address-shaped value", () => {
    expect(usableRegistryContactEmail("  ada@example.org ")).toBe("ada@example.org");
    expect(usableRegistryContactEmail("")).toBeNull();
    expect(usableRegistryContactEmail("ada at example")).toBeNull();
    expect(usableRegistryContactEmail("ada@example.org (lab)")).toBeNull();
  });
});
