import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isSafeBundledReleaseNoteRasterAsset,
  parseReleaseNoteCatalog,
  verifyReleaseNoteForVersion,
  type ReleaseNoteEntry,
} from "./verify-release-notes";

const temporaryDirectories: string[] = [];

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

    expect(verify("/release-notes/1.2.3/hero.webp", true)).toBe("");
    for (const unsafe of [
      "https://example.invalid/pixel.png",
      "http://example.invalid/pixel.png",
      "//example.invalid/pixel.png",
      "data:image/png;base64,AAAA",
      "file:///tmp/pixel.png",
      "blob:scient",
      "/release-notes/../secret.png",
      "/release-notes/hero.svg",
      "/release-notes/hero.png?cache=1",
      "/release-notes/hero.png#fragment",
    ]) {
      expect(verify(unsafe)).toContain("must be a bundled raster asset");
    }
    expect(verify("/release-notes/missing.png")).toContain(
      "must resolve to a regular, non-symlinked raster file",
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
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2dQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(releaseNotesRoot, "1.2.3", "hero.png"), png);
    writeFileSync(
      join(releaseNotesRoot, "truncated.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    writeFileSync(join(releaseNotesRoot, "fake.png"), "not an image");
    mkdirSync(join(releaseNotesRoot, "directory.png"));

    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/1.2.3/hero.png", publicRoot)).toBe(
      true,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/fake.png", publicRoot)).toBe(false);
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/truncated.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/directory.png", publicRoot)).toBe(
      false,
    );
    expect(isSafeBundledReleaseNoteRasterAsset("/release-notes/missing.png", publicRoot)).toBe(
      false,
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
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2dQAAAABJRU5ErkJggg==",
        "base64",
      );
      writeFileSync(validTarget, png);
      writeFileSync(outsideTarget, png);
      symlinkSync(validTarget, join(releaseNotesRoot, "inside-link.png"));
      symlinkSync(outsideTarget, join(releaseNotesRoot, "outside-link.png"));

      expect(
        isSafeBundledReleaseNoteRasterAsset("/release-notes/inside-link.png", publicRoot),
      ).toBe(false);
      expect(
        isSafeBundledReleaseNoteRasterAsset("/release-notes/outside-link.png", publicRoot),
      ).toBe(false);
    },
  );

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
