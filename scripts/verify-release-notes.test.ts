import { describe, expect, it } from "vitest";

import { verifyReleaseNoteForVersion, type ReleaseNoteEntry } from "./verify-release-notes";

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
      "asset does not exist in apps/web/public/release-notes/missing.png",
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

  it("rejects explicit developer-facing language in every visible copy field", () => {
    const technical = entry({
      headline: "Developer refactor",
      features: [
        {
          id: "internal-cleanup",
          title: "React framework cleanup",
          description: "Refactor IPC protocol migration in a component.",
          details: "Implementation details for the renderer runtime.",
          image: "/release-notes/1.2.3/internal.png",
          imageAlt: "Electron codebase diagram",
        },
        ...entry().features.slice(1),
      ],
    });

    const errors = verifyReleaseNoteForVersion("1.2.3", [technical], {
      assetExists: () => true,
    }).errors.join("\n");

    expect(errors).toContain("headline contains developer terminology");
    expect(errors).toContain("title contains framework references");
    expect(errors).toContain("description contains protocol references");
    expect(errors).toContain("details contains implementation details");
    expect(errors).toContain("image alt text contains developer terminology");
  });

  it("rejects release-process references while preserving ordinary user-facing copy", () => {
    const processCopy = entry({
      headline: "Highlights from PR #112",
      features: [
        {
          ...entry().features[0]!,
          title: "Six commits of improvements",
          description: "This pull request updates the experience.",
        },
        ...entry().features.slice(1),
      ],
    });
    const errors = verifyReleaseNoteForVersion("1.2.3", [processCopy]).errors.join("\n");

    expect(errors).toContain("headline contains pull request references");
    expect(errors).toContain("title contains commit references");
    expect(errors).toContain("description contains pull request references");
    expect(verifyReleaseNoteForVersion("1.2.3", [entry()]).errors).toEqual([]);
  });

  it("does not mutate its input", () => {
    const entries = [entry()];
    const before = structuredClone(entries);
    verifyReleaseNoteForVersion("1.2.3", entries);
    expect(entries).toEqual(before);
  });
});
