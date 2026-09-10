import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedCursorArtifact } from "./cursorManifest.ts";

describe("Cursor managed-runtime manifest", () => {
  it("pins every officially supported desktop artifact", () => {
    const targets = [
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" },
      { platform: "linux", arch: "x64", libc: "glibc" },
      { platform: "win32", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ] as const;

    for (const target of targets) {
      const artifact = resolveReviewedCursorArtifact(target);
      expect(artifact).toBeDefined();
      expect(artifact?.provider).toBe("cursor");
      expect(artifact?.version).toBe("2026.08.11-e8db854");
      expect(artifact?.url).toMatch(
        /^https:\/\/downloads\.cursor\.com\/lab\/2026\.08\.11-e8db854\//u,
      );
      expect(artifact?.checksum).toMatchObject({ algorithm: "sha256" });
      expect(artifact?.checksum.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact?.size).toBeGreaterThan(70_000_000);
      expect(artifact?.extractionLimits).toEqual({
        maxEntries: 768,
        maxExpandedBytes: (target.platform === "win32" ? 384 : 768) * 1024 * 1024,
      });
    }
  });

  it("uses the official Windows launcher with a directly executable smoke test", () => {
    const artifact = resolveReviewedCursorArtifact({ platform: "win32", arch: "x64" });

    expect(artifact).toMatchObject({
      archiveFormat: "zip",
      executablePath: "dist-package/cursor-agent.cmd",
      smokeExecutablePath: "dist-package/node.exe",
      smokeWorkingDirectory: "dist-package",
      smokeArgs: ["index.js", "--disable-auto-update", "--version"],
    });
  });

  it("keeps Linux musl manual until the official bundle is qualified there", () => {
    expect(
      resolveReviewedCursorArtifact({ platform: "linux", arch: "x64", libc: "musl" }),
    ).toBeUndefined();
  });
});
