import { describe, expect, it } from "vite-plus/test";
import { toAppModelOption } from "../../modelSelection.ts";

/**
 * Treat providerCostLabel as opaque: preserve it through option mapping and leave it absent when
 * unreported. Rate extraction belongs to the server's DroidAcpSupport tests.
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
});
