import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay (Scient)", () => {
  it("shows a renamed built-in once while retaining a custom model's availability detail", () => {
    const builtIn: ServerProviderModel = {
      slug: "built-in",
      name: "Renamed built-in",
      isCustom: false,
      capabilities: null,
    };
    const display = deriveProviderModelsForDisplay({
      liveModels: [
        builtIn,
        {
          slug: "custom",
          name: "custom",
          isCustom: true,
          capabilities: null,
          unavailableReason: "Synthetic model unavailable",
        },
      ],
      customModels: [
        { slug: "built-in", name: "Renamed built-in", capabilities: null },
        { slug: "custom", name: "My custom model", capabilities: null },
      ],
    });
    expect(display).toEqual([
      builtIn,
      {
        slug: "custom",
        name: "My custom model",
        isCustom: true,
        capabilities: null,
        unavailableReason: "Synthetic model unavailable",
      },
    ]);
  });

  it("retains a discovered connection model independently of the legacy list", () => {
    const liveModels: ServerProviderModel[] = [
      {
        slug: "custom:scient-fixture",
        name: "Connected model",
        isCustom: false,
        capabilities: null,
      },
    ];
    expect(deriveProviderModelsForDisplay({ liveModels, customModels: [] })).toEqual(liveModels);
  });
});
