import { describe, expect, it } from "vite-plus/test";

import { decodePiModelSlug, encodePiModelSlug } from "./model.ts";

describe("PiModel", () => {
  it("round-trips provider and model ids with one raw delimiter", () => {
    const slug = encodePiModelSlug("open/router", "model / β");
    expect(slug).toBe("open%2Frouter/model%20%2F%20%CE%B2");
    expect(decodePiModelSlug(slug!)).toEqual({ provider: "open/router", modelId: "model / β" });
  });

  it.each(["provider", "/model", "provider/", "provider/model/extra", "a/%", "a/%2f", " a/model"])(
    "rejects invalid or noncanonical slug %s",
    (slug) => expect(decodePiModelSlug(slug)).toBeUndefined(),
  );
});
