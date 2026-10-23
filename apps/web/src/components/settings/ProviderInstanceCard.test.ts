import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldValue,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
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

  it.each(["custom:scient-fixture", "scient_fixture/model"])(
    "retains discovered connection %s independently of the legacy list",
    (slug) => {
      const liveModels: ServerProviderModel[] = [
        { slug, name: "Connected model", isCustom: false, capabilities: null },
      ];
      expect(deriveProviderModelsForDisplay({ liveModels, customModels: [] })).toEqual(liveModels);
      expect(deriveProviderModelsForDisplay({ liveModels: [], customModels: [] })).toEqual([]);
    },
  );

  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("provider environment helpers", () => {
  const cursorApiKeyField = {
    name: "CURSOR_API_KEY",
    label: "Cursor API key",
    sensitive: true,
  };

  it("writes dedicated provider secrets as sensitive environment variables", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "EXTRA_FLAG", value: "1", sensitive: false }],
        cursorApiKeyField,
        "  cursor-key  ",
      ),
    ).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
    ]);
  });

  it("replaces redacted provider secrets without preserving redaction markers", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [
          {
            name: "CURSOR_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
        cursorApiKeyField,
        "new-key",
      ),
    ).toEqual([{ name: "CURSOR_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("applies the secure field default when replacing an existing non-sensitive value", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: false }],
        {
          name: "OPENAI_API_KEY",
          label: "OpenAI API key",
        },
        "new-key",
      ),
    ).toEqual([{ name: "OPENAI_API_KEY", value: "new-key", sensitive: true }]);
  });
});
