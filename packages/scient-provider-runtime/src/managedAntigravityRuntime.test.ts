import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedAntigravityArtifact } from "./antigravityManifest.ts";
import { ManagedAntigravityRuntime } from "./managedAntigravityRuntime.ts";

describe("ManagedAntigravityRuntime", () => {
  it("keeps Antigravity in its own provider-private runtime root", () => {
    const artifact = resolveReviewedAntigravityArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedAntigravityRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/antigravity\/versions\/1\.1\.20\/darwin-arm64\/antigravity$/u,
    );
  });
});
