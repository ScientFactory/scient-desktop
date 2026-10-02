import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { resolveAutomaticModel, resolveSelectableModel } from "./model.ts";

describe("known unavailable models", () => {
  const unavailable = {
    slug: "anthropic/claude",
    name: "Claude",
    aliases: ["old-claude"],
    isDefault: true,
    unavailableReason: "Account access required.",
  };
  const unverified = { slug: "local/model", name: "Local model" };
  it.each(["omp", "pi", "codex"])(
    "excludes unavailable %s defaults without inventing access",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      expect(resolveAutomaticModel(driver, [unavailable, unverified])).toBe(unverified.slug);
      expect(resolveAutomaticModel(driver, [unavailable])).toBeUndefined();
    },
  );
  it.each(["anthropic/claude", "Claude", "old-claude"])(
    "rejects unavailable selection %s",
    (value) => {
      expect(
        resolveSelectableModel(ProviderDriverKind.make("omp"), value, [unavailable, unverified]),
      ).toBeNull();
    },
  );
  it("does not treat omitted access metadata as unavailability", () => {
    expect(
      resolveSelectableModel(ProviderDriverKind.make("omp"), unverified.slug, [unverified]),
    ).toBe(unverified.slug);
  });
});
