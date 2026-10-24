import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { modelOptionMemoryAtom } from "./use-composer-drafts";
import { withRememberedModelOptions } from "./use-model-option-memory";

describe("withRememberedModelOptions", () => {
  it("preserves the incoming selection and option order when memory is semantically equal", () => {
    appAtomRegistry.set(modelOptionMemoryAtom, {
      pi: {
        "xai/grok-4.6": [
          { id: "thinking", value: "high" },
          { id: "search", value: true },
        ],
      },
    });
    try {
      const selection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "xai/grok-4.6",
        options: [
          { id: "search", value: true },
          { id: "thinking", value: "high" },
        ],
      };
      expect(withRememberedModelOptions(selection)).toBe(selection);
      expect(selection.options.map((option) => option.id)).toEqual(["search", "thinking"]);
    } finally {
      appAtomRegistry.set(modelOptionMemoryAtom, {});
    }
  });
});
