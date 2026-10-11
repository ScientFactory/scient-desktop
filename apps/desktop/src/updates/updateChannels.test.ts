import { describe, expect, it } from "vite-plus/test";
import { isEmptyBetaFeedError, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("Scient update defaults", () => {
  it("classifies Stable and Beta while preserving legacy tag parsing", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.6.22")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.6.23-beta.20261010.1")).toBe("beta");
    expect(resolveDefaultDesktopUpdateChannel("0.6.23-nightly.20261010.1")).toBe("nightly");
  });
  it("recognizes only empty-release errors, preserving transport and integrity failures", () => {
    expect(isEmptyBetaFeedError(new Error("No published versions on GitHub"))).toBe(true);
    expect(isEmptyBetaFeedError(new Error("404"))).toBe(false);
    expect(isEmptyBetaFeedError(new Error("checksum mismatch"))).toBe(false);
  });
});
