import { isExtensionIconDataUri } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { normalizeBrandIconName } from "./BrandIconNames.ts";
import { resolveBrandIcon } from "./BrandIcons.ts";
import sourceList from "../../../../../scripts/scient-extension-brands.json" with { type: "json" };
import aliases from "./brandIcons/aliases.json" with { type: "json" };
import icons from "./brandIcons/brandIcons.json" with { type: "json" };
import curated from "./discover/curatedIcons.json" with { type: "json" };

describe("bundled extension brand icons", () => {
  it("records a source for every shipped logo", () => {
    const sources: Array<{
      key: string;
      source?: {
        url?: string;
        type?: string;
        appId?: number;
        sellerName?: string;
        repositorySource?: string;
      };
    }> = sourceList;
    for (const key of Object.keys({ ...curated, ...icons })) {
      const source = sources.find((entry) => entry.key === key)?.source;
      expect(
        Boolean(
          source?.url &&
          (/^https?:/.test(source.url) ||
            (source.url.startsWith("data:image/") && source.repositorySource)),
        ),
        key,
      ).toBe(true);
      expect(["app-store", "own-tile", "fallback"], key).toContain(source?.type);
      if (source?.type === "app-store") {
        expect(source.appId, key).toBeGreaterThan(0);
        expect(source.sellerName, key).toBeTruthy();
      }
    }
  });

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
      const bytes = Buffer.from(data.split(",")[1]!, "base64");
      expect(bytes.length, key).toBeLessThanOrEqual(25_600);
      expect(bytes.toString("ascii", 0, 4), key).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12), key).toBe("WEBP");
      let dimensions: [number, number] | undefined;
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString("ascii", offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        expect(type, `${key}: opaque corners`).not.toBe("ALPH");
        if (type === "VP8X") expect(bytes[offset + 8]! & 0x10, key).toBe(0);
        if (type === "VP8 ")
          dimensions = [
            bytes.readUInt16LE(offset + 14) & 0x3fff,
            bytes.readUInt16LE(offset + 16) & 0x3fff,
          ];
        offset += 8 + length + (length % 2);
      }
      // Lossy VP8 without an alpha chunk is opaque across the entire tile.
      expect(dimensions, key).toEqual([256, 256]);
      expect(resolveBrandIcon(key), key).toBe(data);
    }
    for (const [name, key] of Object.entries(aliases)) {
      expect(images[key], name).toBeDefined();
      expect(resolveBrandIcon(name), name).toBe(images[key]);
    }
  });
});
