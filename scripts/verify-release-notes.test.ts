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
      heroImage: "/hero.png",
      features: [
        { id: "same", title: "", description: " " },
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

  it("requires one to five highlights and paired feature artwork", () => {
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
    expect(errors).toContain("between 1 and 5");
    expect(errors).toContain("accessible alt text must be provided together");
  });

  it("does not mutate its input", () => {
    const entries = [entry()];
    const before = structuredClone(entries);
    verifyReleaseNoteForVersion("1.2.3", entries);
    expect(entries).toEqual(before);
  });
});
