import { describe, expect, it } from "vite-plus/test";
import { toAppModelOption } from "../../modelSelection.ts";
import type { ModelEsque } from "./providerIconUtils";

/**
 * The web layer renders `providerCostLabel` verbatim as an opaque
 * provider-formatted label; the extraction itself is owned (and tested) by
 * the server (`droidCostMultiplierLabel` in DroidAcpSupport). These cases pin
 * the web contract: the label rides through model-option mapping unchanged
 * and stays absent when the provider reports nothing.
 */
describe("model providerCostLabel plumbing", () => {
  it("carries a provider cost label through to app model options", () => {
    const option = toAppModelOption({
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: null,
      providerCostLabel: "0.5×",
    } as never);
    expect(option.providerCostLabel).toBe("0.5×");
  });

  it("leaves the label absent when the snapshot has none", () => {
    const option = toAppModelOption({
      slug: "auto",
      name: "Auto",
      isCustom: false,
      capabilities: null,
    } as never);
    expect(option.providerCostLabel).toBeUndefined();
  });

  it("is carried on picker rows as an optional field", () => {
    const withBadge: ModelEsque = {
      slug: "composer-2",
      name: "Composer 2",
      providerCostLabel: "0.5×",
    };
    const withoutBadge: ModelEsque = { slug: "auto", name: "Auto" };
    expect(withBadge.providerCostLabel).toBe("0.5×");
    expect(withoutBadge.providerCostLabel).toBeUndefined();
  });
});
