import { describe, expect, it } from "@effect/vitest";

import { publisherArtworkCandidates, publisherControlsWebsite } from "./JournalPublisherArtwork.ts";

describe("publisherArtworkCandidates", () => {
  it("normalizes presentation without broadening the publisher identity", () => {
    const candidates = publisherArtworkCandidates({ publisher: "  ＳＡＧＥ\t Publishing\n" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.publisher).toBe("Sage");
    expect(candidates[0]?.kind).toBe("page");
    expect(candidates[0]?.url.hostname).toBe("www.sagepub.com");
  });

  it("does not infer a publisher from a partial name, related name, or missing value", () => {
    for (const publisher of [
      null,
      "",
      "Not Wiley",
      "Wiley Unverified Imprint",
      "Springer",
      "American Physiological Society",
      "Chemical Society",
      "National Academy of Sciences of Belarus",
    ]) {
      expect(publisherArtworkCandidates({ publisher })).toEqual([]);
    }
  });

  it("accepts controlled subdomains but not lookalike, repository or unrelated publisher sites", () => {
    expect(
      publisherControlsWebsite(
        { publisher: "Wiley" },
        new URL("https://onlinelibrary.wiley.com/paper"),
      ),
    ).toBe(true);
    for (const url of [
      "https://wiley.com.attacker.example/paper",
      "https://wiley.github.io/paper",
      "https://repository.university.example/paper",
      "https://www.nature.com/paper",
    ])
      expect(publisherControlsWebsite({ publisher: "Wiley" }, new URL(url))).toBe(false);
    expect(
      publisherControlsWebsite({ publisher: "Not Wiley" }, new URL("https://www.wiley.com/")),
    ).toBe(false);
  });
});
