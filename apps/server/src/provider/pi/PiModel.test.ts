import { describe, expect, it } from "vite-plus/test";

import { decodePiModelSlug, encodePiModelSlug, mapPiDiscoveredModels } from "./PiModel.ts";

describe("PiModel", () => {
  it("uses the custom preference for the badge without changing supported levels", () => {
    const [model] = mapPiDiscoveredModels([
      {
        provider: "test",
        id: "luna",
        name: "Luna",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
    ]);
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(
      descriptor?.type === "select" &&
        descriptor.options.filter((option) => option.isDefault).map((option) => option.id),
    ).toEqual(["high"]);
  });
  it("exposes only concrete enabled efforts, with one next-turn default and no diagnostics", () => {
    const model = mapPiDiscoveredModels([
      {
        provider: "openai",
        id: "test",
        name: "Test",
        reasoningMetadata: {
          status: "known",
          source: "catalog",
          supported: true,
          levels: ["off", "low", "medium", "high", "xhigh", "max"],
          defaultLevel: "medium",
          stale: false,
          checkedAt: "2026-09-06T00:00:00.000Z",
        },
      },
    ])[0];
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.description).toBeUndefined();
    expect(descriptor?.type === "select" && descriptor.options.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      descriptor?.type === "select" &&
        descriptor.options.filter((option) => option.isDefault).map((option) => option.id),
    ).toEqual(["medium"]);
  });
  it("round-trips provider and model ids with one raw delimiter", () => {
    const slug = encodePiModelSlug("open/router", "model / β");
    expect(slug).toBe("open%2Frouter/model%20%2F%20%CE%B2");
    expect(decodePiModelSlug(slug!)).toEqual({ provider: "open/router", modelId: "model / β" });
  });

  it.each(["provider", "/model", "provider/", "provider/model/extra", "a/%", "a/%2f", " a/model"])(
    "rejects invalid or noncanonical slug %s",
    (slug) => expect(decodePiModelSlug(slug)).toBeUndefined(),
  );

  it("maps Pi's configured model and thinking defaults", () => {
    expect(
      mapPiDiscoveredModels(
        [
          {
            provider: "anthropic",
            id: "claude/opus",
            name: "Claude Opus",
            thinkingLevels: ["low", "high", "max"],
          },
          { provider: " ", id: "bad", name: "Bad" },
        ],
        {
          provider: "anthropic",
          modelId: "claude/opus",
          thinkingLevel: "high",
        },
      ),
    ).toEqual([
      {
        slug: "anthropic/claude%2Fopus",
        name: "Claude Opus",
        subProvider: "anthropic",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinkingLevel",
              label: "Reasoning",
              type: "select",
              strictSelection: true,
              concreteReasoning: true,
              emptySelectionLabel: "Reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("does not assign the discovery session's current effort to another model", () => {
    const models = mapPiDiscoveredModels(
      [
        { provider: "pi", id: "first", name: "First", reasoning: true },
        { provider: "pi", id: "second", name: "Second", reasoning: true },
      ],
      { provider: "pi", modelId: "first", thinkingLevel: "high" },
    );
    expect(models[1]?.capabilities?.optionDescriptors?.[0]?.currentValue).toBeUndefined();
  });

  it("uses only provider-reported custom levels without promoting a catalog default to active state", () => {
    const [model] = mapPiDiscoveredModels(
      [
        {
          provider: "scient_router",
          id: "glm",
          name: "GLM",
          reasoning: true,
          reasoningMetadata: {
            status: "known",
            source: "provider",
            checkedAt: "2026-09-06T00:00:00.000Z",
            stale: false,
            supported: true,
            levels: ["low", "high", "max"],
            defaultLevel: "max",
            mandatory: true,
          },
        },
      ],
      { provider: "scient_router", modelId: "glm", thinkingLevel: "off" },
    );
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.currentValue).toBeUndefined();
    expect(descriptor?.type === "select" && descriptor.options.map((option) => option.id)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("keeps unknown distinct from a known non-reasoning model", () => {
    const models = mapPiDiscoveredModels(
      [null, false].map((supported) => ({
        provider: "scient_local",
        id: String(supported),
        name: String(supported),
        reasoningMetadata: {
          status: supported === null ? ("unknown" as const) : ("known" as const),
          source: "unknown" as const,
          checkedAt: "2026-09-06T00:00:00.000Z",
          stale: false,
          supported,
          levels: [],
        },
      })),
    );
    expect(
      models.map((model) => {
        const descriptor = model.capabilities?.optionDescriptors?.[0];
        return descriptor?.type === "select" ? descriptor.emptySelectionLabel : undefined;
      }),
    ).toEqual(["Reasoning", "Reasoning"]);
  });
});
