import { isExtensionIconDataUri } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { normalizeBrandIconName } from "./BrandIconNames.ts";
import { resolveBrandIcon } from "./BrandIcons.ts";
import aliases from "./brandIcons/aliases.json" with { type: "json" };
import icons from "./brandIcons/brandIcons.json" with { type: "json" };
import curated from "./discover/curatedIcons.json" with { type: "json" };

describe("bundled extension brand icons", () => {
  it("normalizes provider prefixes, marketplace suffixes, separators and whitespace", () => {
    expect(normalizeBrandIconName("  Claude.ai Google_- Drive@official  ")).toBe("google drive");
  });

  it("resolves exact aliases without fuzzy matches or provider configuration", () => {
    expect(resolveBrandIcon("claude.ai gdrive@official")).toBe(resolveBrandIcon("Google Drive"));
    expect(resolveBrandIcon("Google Drive")).toBeDefined();
    expect(resolveBrandIcon("monday.com")).toBe(curated.monday);
    expect(resolveBrandIcon("save-to-spotify")).toBe(resolveBrandIcon("Spotify"));
    for (const name of ["Google Drive Helper", "Drive", "", "constructor", "__proto__"])
      expect(resolveBrandIcon(name)).toBeUndefined();
  });

  it("ships only valid inline icons with complete exact alias targets", () => {
    const images: Readonly<Record<string, string>> = { ...curated, ...icons };
    for (const [key, data] of Object.entries(images)) {
      expect(isExtensionIconDataUri(data), key).toBe(true);
      expect(resolveBrandIcon(key), key).toBe(data);
    }
    for (const [name, key] of Object.entries(aliases)) {
      expect(images[key], name).toBeDefined();
      expect(resolveBrandIcon(name), name).toBe(images[key]);
    }
  });
});
