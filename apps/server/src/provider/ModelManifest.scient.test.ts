import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

import * as ModelManifest from "./ModelManifest.ts";

describe("resolveProviderCatalog", () => {
  it("uses legacy-only remote metadata without erasing unknown native legacy models", () => {
    const catalog = ModelManifest.resolveProviderCatalog(
      { version: 1, currentModels: { synthetic: ["native-current"] } },
      ProviderDriverKind.make("synthetic"),
    );
    const models = ModelCatalog.classifyCatalogModels(
      ["native-current", "native-unknown"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        isLegacy: true,
        capabilities: null,
      })),
      catalog ?? undefined,
    );
    assert.isUndefined(models[0]?.isLegacy);
    assert.isTrue(models[1]?.isLegacy);
  });
});
