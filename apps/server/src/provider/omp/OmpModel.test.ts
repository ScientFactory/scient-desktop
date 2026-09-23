import { describe, expect, it } from "vite-plus/test";

import {
  decodeOmpModelSlug,
  encodeOmpModelSlug,
  ompModelToServerModel,
  ompThinkingLevel,
} from "./OmpModel.ts";

describe("Oh My Pi model slugs", () => {
  it("round-trips a provider and model id", () => {
    const slug = encodeOmpModelSlug("openai", "gpt-5");
    expect(slug).toBe("openai/gpt-5");
    expect(decodeOmpModelSlug(slug ?? "")).toEqual({ provider: "openai", modelId: "gpt-5" });
  });

  it("rejects a slug that is not one canonical segment pair", () => {
    expect(decodeOmpModelSlug("openai")).toBeUndefined();
    expect(decodeOmpModelSlug("openai/gpt/5")).toBeUndefined();
    expect(decodeOmpModelSlug("openai/gpt-5 ")).toBeUndefined();
    expect(encodeOmpModelSlug(" open", "gpt-5")).toBeUndefined();
  });

  it("keeps only known thinking levels and exposes them as a reasoning option", () => {
    expect(ompThinkingLevel("xhigh")).toBe("xhigh");
    expect(ompThinkingLevel("turbo")).toBeUndefined();
    const model = ompModelToServerModel({
      provider: "anthropic",
      id: "claude",
      reasoning: true,
      thinkingLevels: ["low", "mystery", "high"],
    });
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(model?.slug).toBe("anthropic/claude");
    expect(descriptor?.id).toBe("thinkingLevel");
    expect(
      descriptor && "options" in descriptor ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["low", "high"]);
  });
});
