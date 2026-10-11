import { describe, expect, it } from "vite-plus/test";
import {
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "./cliRelease.ts";

describe("Scient release channel isolation", () => {
  it("never offers prereleases to stable CLI or mobile environments", () => {
    const releases = [
      { tag_name: "v0.6.24-beta.20261010.2", prerelease: false },
      { tag_name: "v0.6.24-rc.1", prerelease: false },
      { tag_name: "v0.6.24", prerelease: true },
      { tag_name: "v0.6.23", draft: true },
      { tag_name: "v0.6.22", prerelease: false },
    ];
    expect(newestCliReleaseVersion(releases, "stable")).toBe("0.6.22");
    expect(newestCliReleaseVersion(releases, "beta")).toBe("0.6.24-beta.20261010.2");
    expect(cliReleaseChannelOf("0.6.24-beta.20261010.2")).toBe("beta");
  });

  it("queries the separate artifact index only for Beta", () => {
    expect(cliReleaseIndexPageUrl(2, "beta")).toBe(
      "https://api.github.com/repos/ScientFactory/scient-desktop-beta/releases?per_page=100&page=2",
    );
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/ScientFactory/scient-desktop/releases?per_page=100&page=1",
    );
  });
});
