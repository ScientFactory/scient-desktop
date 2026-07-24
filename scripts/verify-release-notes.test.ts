import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  isSafeBundledReleaseNoteRasterAsset,
  parseReleaseNoteCatalog,
  verifyBundledReleaseNoteAssetTree,
  verifyReleaseNoteForVersion,
  type ReleaseNoteEntry,
} from "./verify-release-notes";

const temporaryDirectories: string[] = [];

const { PNG } = createRequire(import.meta.url)("pngjs") as {
  readonly PNG: {
    readonly sync: {
      write(image: {
        readonly width: number;
        readonly height: number;
        readonly data: Buffer;
      }): Buffer;
    };
  };
};

const makeValidPng = () =>
  PNG.sync.write({ width: 1, height: 1, data: Buffer.from([46, 125, 246, 255]) });

function makePngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function insertBeforeIdat(png: Buffer, chunks: readonly Buffer[]): Buffer {
  let offset = 8;
  while (offset < png.length) {
    const chunkLength = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      return Buffer.concat([png.subarray(0, offset), ...chunks, png.subarray(offset)]);
    }
    offset += 12 + chunkLength;
  }
  throw new Error("Expected generated PNG to contain IDAT.");
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const entry = (overrides: Partial<ReleaseNoteEntry> = {}): ReleaseNoteEntry => ({
  version: "1.2.3",
  date: "July 24, 2026",
  headline: "A calmer, clearer workspace",
  features: [
    {
      id: "clearer-workspace",
      title: "Find your work faster",
      description: "The workspace now keeps the things you need easier to reach.",
    },
    {
      id: "calmer-updates",
      title: "Understand each update",
      description: "Release notes now focus on what became better for you.",
    },
    {
      id: "quieter-notices",
      title: "Stay in control",
      description: "The note appears once and waits for you to open it.",
    },
  ],
  ...overrides,
});

describe("verifyReleaseNoteForVersion", () => {
  it("requires exactly one exact release entry and normalizes a target v prefix", () => {
    expect(verifyReleaseNoteForVersion("v1.2.3", [entry()])).toEqual({
      version: "1.2.3",
      errors: [],
    });
    expect(verifyReleaseNoteForVersion("1.2.4", [entry()]).errors).toContain(
      "Release 1.2.4 requires exactly one curated Scient release note; found 0.",
    );
  });

  it("keeps stable and prerelease notes distinct", () => {
    expect(
      verifyReleaseNoteForVersion("1.2.3-beta.1", [entry({ version: "1.2.3" })]).errors,
    ).toContain("Release 1.2.3-beta.1 requires exactly one curated Scient release note; found 0.");
  });

  it("rejects malformed and duplicate catalog data", () => {
    const malformed = entry({
      version: "01.2.3",
      date: " ",
      headline: " ",
      features: [
        { id: "same", title: "", description: " ", image: "/release-notes/missing.png" },
        { id: "same", title: "Title", description: "Description", details: " " },
      ],
    });
    const errors = verifyReleaseNoteForVersion("1.2.3", [malformed, malformed]).errors.join("\n");
    expect(errors).toContain("canonical full semantic version");
    expect(errors).toContain("appears more than once");
    expect(errors).toContain("needs a release date");
    expect(errors).toContain("needs a benefit-led headline");
    expect(errors).toContain("provided together");
    expect(errors).toContain("reuses id same");
    expect(errors).toContain("needs a title");
    expect(errors).toContain("needs a description");
    expect(errors).toContain("details cannot be blank");
  });

  it("requires three to five standard highlights and permits a concise declared hotfix", () => {
    const noFeatures = entry({ features: [] });
    const tooMany = entry({
      version: "1.2.4",
      features: Array.from({ length: 6 }, (_, index) =>
        index === 0
          ? {
              id: `feature-${index}`,
              title: "Title",
              description: "Description",
              imageAlt: "Missing image",
            }
          : {
              id: `feature-${index}`,
              title: "Title",
              description: "Description",
            },
      ),
    });
    const errors = verifyReleaseNoteForVersion("1.2.3", [noFeatures, tooMany]).errors.join("\n");
    expect(errors).toContain("between 3 and 5");
    expect(errors).toContain("accessible alt text must be provided together");

    expect(
      verifyReleaseNoteForVersion("1.2.3", [
        entry({ kind: "hotfix", features: [entry().features[0]!] }),
      ]).errors,
    ).toEqual([]);
    expect(
      verifyReleaseNoteForVersion("1.2.3", [entry({ features: entry().features.slice(0, 2) })])
        .errors,
    ).toContain("Entry 1 must contain between 3 and 5 user-facing highlights.");
  });

  it("allows only existing bundled raster artwork under the release-notes directory", () => {
    const withHero = (heroImage: string) => entry({ heroImage });
    const verify = (heroImage: string, exists = false) =>
      verifyReleaseNoteForVersion("1.2.3", [withHero(heroImage)], {
        assetExists: () => exists,
      }).errors.join("\n");

    expect(verify("/release-notes/1.2.3/hero.png", true)).toBe("");
    for (const unsafe of [
      "https://example.invalid/pixel.png",
      "http://example.invalid/pixel.png",
      "//example.invalid/pixel.png",
      "data:image/png;base64,AAAA",
      "file:///tmp/pixel.png",
      "blob:scient",
      "/release-notes/../secret.png",
      "/release-notes/hero.svg",
      "/release-notes/hero.jpg",
      "/release-notes/hero.webp",
      "/release-notes/hero.avif",
      "/release-notes/hero.png?cache=1",
      "/release-notes/hero.png#fragment",
    ]) {
      expect(verify(unsafe)).toContain("must be a bundled PNG asset");
    }
    expect(verify("/release-notes/missing.png")).toContain(
      "must resolve to a regular, non-symlinked PNG file",
    );

    const blankImageErrors = verifyReleaseNoteForVersion("1.2.3", [
      entry({
        features: [
          { ...entry().features[0]!, image: "", imageAlt: "A release highlight" },
          ...entry().features.slice(1),
        ],
      }),
    ]).errors;
    expect(
      blankImageErrors.filter((error) => error === "Entry 1, highlight 1 image is blank."),
    ).toHaveLength(1);
  });

  it("requires a real, contained raster file instead of accepting names alone", () => {
    const publicRoot = mkdtempSync(join(tmpdir(), "scient-release-notes-"));
    temporaryDirectories.push(publicRoot);
    const releaseNotesRoot = join(publicRoot, "release-notes");
    mkdirSync(join(releaseNotesRoot, "1.2.3"), { recursive: true });
    const png = makeValidPng();
    writeFileSync(join(releaseNotesRoot, "1.2.3", "hero.png"), png);
    writeFileSync(
      join(releaseNotesRoot, "truncated.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    writeFileSync(join(releaseNotesRoot, "fake.png"), "not an image");
    const forged = Buffer.from(png);
    const forgedByteIndex = forged.length - 13;
    forged.writeUInt8(forged.readUInt8(forgedByteIndex) ^ 0xff, forgedByteIndex);
    writeFileSync(join(releaseNotesRoot, "forged.png"), forged);
    writeFileSync(join(releaseNotesRoot, "cut-off.png"), png.subarray(0, png.length - 8));
    const interlaced = Buffer.from(png);
    interlaced[28] = 1;
    writeFileSync(join(releaseNotesRoot, "interlaced.png"), interlaced);
    const oversizedPath = join(releaseNotesRoot, "oversized.png");
    writeFileSync(oversizedPath, png);
    truncateSync(oversizedPath, 10 * 1024 * 1024 + 1);
    writeFileSync(
      join(releaseNotesRoot, "oversized-palette.png"),
      insertBeforeIdat(png, [makePngChunk("PLTE", Buffer.alloc(771))]),
    );
    writeFileSync(
      join(releaseNotesRoot, "too-many-chunks.png"),
      insertBeforeIdat(
        png,
        Array.from({ length: 256 }, () => makePngChunk("vpAg")),
      ),
    );
    const corruptAncillaryChunk = Buffer.from(makePngChunk("vpAg", Buffer.from("Scient")));
    const corruptCrcByteIndex = corruptAncillaryChunk.length - 1;
    corruptAncillaryChunk.writeUInt8(
      corruptAncillaryChunk.readUInt8(corruptCrcByteIndex) ^ 0xff,
      corruptCrcByteIndex,
    );
    writeFileSync(
      join(releaseNotesRoot, "corrupt-ancillary-crc.png"),
      insertBeforeIdat(png, [corruptAncillaryChunk]),
    );
    mkdirSync(join(releaseNotesRoot, "directory.png"));

    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/1.2.3/hero.png", publicRoot)).toBe(
      true,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/fake.png", publicRoot)).toBe(false);
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/forged.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/cut-off.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/truncated.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/interlaced.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/oversized.png", publicRoot)).toBe(
      false,
    );
    expect(
      isSafeBundledReleaseNoteRasterAsset("/release-notes/oversized-palette.png", publicRoot),
    ).toBe(false);
    expect(
      isSafeBundledReleaseNoteRasterAsset("/release-notes/too-many-chunks.png", publicRoot),
    ).toBe(false);
    expect(
      isSafeBundledReleaseNoteRasterAsset("/release-notes/corrupt-ancillary-crc.png", publicRoot),
    ).toBe(false);
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/directory.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/missing.png", publicRoot)).toBe(
      false,
    );
  });

  it("uses a custom public root for referenced artwork as well as full-tree scanning", () => {
    const publicRoot = mkdtempSync(join(tmpdir(), "scient-release-notes-reference-"));
    temporaryDirectories.push(publicRoot);
    const releaseNotesRoot = join(publicRoot, "release-notes", "1.2.3");
    mkdirSync(releaseNotesRoot, { recursive: true });
    writeFileSync(join(releaseNotesRoot, "hero.png"), makeValidPng());

    expect(
      verifyReleaseNoteForVersion(
        "1.2.3",
        [entry({ heroImage: "/release-notes/1.2.3/hero.png" })],
        { publicRoot },
      ).errors,
    ).toEqual([]);
  });

  it("scans every release-note asset, including unreferenced leaves", () => {
    const publicRoot = mkdtempSync(join(tmpdir(), "scient-release-notes-tree-"));
    temporaryDirectories.push(publicRoot);
    const releaseNotesRoot = join(publicRoot, "release-notes");
    mkdirSync(join(releaseNotesRoot, "1.2.3"), { recursive: true });
    const png = makeValidPng();
    writeFileSync(join(releaseNotesRoot, "1.2.3", "hero.png"), png);
    expect(verifyBundledReleaseNoteAssetTree(publicRoot)).toEqual([]);

    writeFileSync(join(releaseNotesRoot, "unreferenced.html"), "<script>unsafe()</script>");
    writeFileSync(join(releaseNotesRoot, "unreferenced.png"), "not actually a PNG");
    const expectedErrors = [
      "/release-notes/unreferenced.html must be a PNG file; other public-tree leaves are not allowed.",
      "/release-notes/unreferenced.png must be a decodable PNG within the release-note asset tree.",
    ];
    expect(verifyBundledReleaseNoteAssetTree(publicRoot)).toEqual(expectedErrors);
    expect(verifyReleaseNoteForVersion("1.2.3", [entry()], { publicRoot }).errors).toEqual(
      expectedErrors,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects in-root and escaping release-note symlinks",
    () => {
      const publicRoot = mkdtempSync(join(tmpdir(), "scient-release-notes-links-"));
      temporaryDirectories.push(publicRoot);
      const releaseNotesRoot = join(publicRoot, "release-notes");
      mkdirSync(releaseNotesRoot, { recursive: true });
      const validTarget = join(releaseNotesRoot, "target.png");
      const outsideTarget = join(publicRoot, "outside.png");
      const outsideDirectory = join(publicRoot, "outside-directory");
      const png = makeValidPng();
      writeFileSync(validTarget, png);
      writeFileSync(outsideTarget, png);
      mkdirSync(outsideDirectory);
      writeFileSync(join(outsideDirectory, "escaped.html"), "not public release-note content");
      symlinkSync(validTarget, join(releaseNotesRoot, "inside-link.png"));
      symlinkSync(outsideTarget, join(releaseNotesRoot, "outside-link.png"));
      symlinkSync(outsideDirectory, join(releaseNotesRoot, "escaped-directory"), "dir");

      expect(
        isSafeBundledReleaseNoteRasterAsset("/release-notes/inside-link.png", publicRoot),
      ).toBe(false);
      expect(
        isSafeBundledReleaseNoteRasterAsset("/release-notes/outside-link.png", publicRoot),
      ).toBe(false);
      expect(verifyBundledReleaseNoteAssetTree(publicRoot)).toEqual([
        "/release-notes/escaped-directory must not be a symlink.",
        "/release-notes/inside-link.png must not be a symlink.",
        "/release-notes/outside-link.png must not be a symlink.",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")("rejects unreferenced non-regular leaves", () => {
    const publicRoot = mkdtempSync(join(tmpdir(), "scient-release-notes-special-"));
    temporaryDirectories.push(publicRoot);
    const releaseNotesRoot = join(publicRoot, "release-notes");
    mkdirSync(releaseNotesRoot, { recursive: true });
    const fifoPath = join(releaseNotesRoot, "unreferenced.png");
    const result = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(verifyBundledReleaseNoteAssetTree(publicRoot)).toEqual([
      "/release-notes/unreferenced.png must be a regular file or directory.",
    ]);
  });

  it("decodes catalog field shapes before semantic validation", () => {
    expect(parseReleaseNoteCatalog([entry()])).toEqual([entry()]);
    expect(() => parseReleaseNoteCatalog([{ ...entry(), date: undefined }])).toThrow(
      "Entry 1 date must be a string.",
    );
    expect(() =>
      parseReleaseNoteCatalog([{ ...entry(), features: [{ ...entry().features[0], title: 4 }] }]),
    ).toThrow("Entry 1, highlight 1 title must be a string.");
    expect(() => parseReleaseNoteCatalog([null])).toThrow("Entry 1 must be an object.");
  });

  it("does not mutate its input", () => {
    const entries = [entry()];
    const before = structuredClone(entries);
    verifyReleaseNoteForVersion("1.2.3", entries);
    expect(entries).toEqual(before);
  });
});
