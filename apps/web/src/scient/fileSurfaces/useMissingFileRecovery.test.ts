import { describe, expect, it } from "vite-plus/test";

import { canOfferPrivacySettings, missingFileCandidates } from "./useMissingFileRecovery";

describe("missingFileCandidates", () => {
  it("offers every same-named project file except the missing path itself", () => {
    expect(
      missingFileCandidates("reviews/notes.md", [
        { path: "reviews/notes.md", kind: "file" },
        { path: "archive/notes.md", kind: "file" },
        { path: "drafts/notes.md", kind: "file" },
        { path: "drafts/notes.md.bak", kind: "file" },
        { path: "notes.md", kind: "directory" },
      ]),
    ).toEqual(["archive/notes.md", "drafts/notes.md"]);
  });

  it("matches the basename of an absolute host path", () => {
    expect(
      missingFileCandidates("/Users/me/reviews/notes.md", [
        { path: "reviews/notes.md", kind: "file" },
      ]),
    ).toEqual(["reviews/notes.md"]);
  });

  it("caps the choices it offers", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `dir${index}/notes.md`,
      kind: "file" as const,
    }));
    expect(missingFileCandidates("notes.md", entries)).toHaveLength(5);
  });
});

describe("canOfferPrivacySettings", () => {
  const local = {
    failureReason: "permission_denied" as const,
    isLocalEnvironment: true,
    platform: "MacIntel",
    hasSystemSettingsBridge: true,
  };

  it("offers System Settings for a denied read on this Mac in the desktop shell", () => {
    expect(canOfferPrivacySettings(local)).toBe(true);
  });

  it("offers nothing where System Settings cannot help", () => {
    expect(canOfferPrivacySettings({ ...local, failureReason: "not_found" })).toBe(false);
    expect(canOfferPrivacySettings({ ...local, failureReason: null })).toBe(false);
    expect(canOfferPrivacySettings({ ...local, isLocalEnvironment: false })).toBe(false);
    expect(canOfferPrivacySettings({ ...local, platform: "Win32" })).toBe(false);
    expect(canOfferPrivacySettings({ ...local, hasSystemSettingsBridge: false })).toBe(false);
  });
});
