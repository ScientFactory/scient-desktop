import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedGrokArtifact } from "./grokManifest.ts";
import { ManagedGrokRuntime } from "./managedGrokRuntime.ts";

describe("ManagedGrokRuntime conformance", () => {
  it("keeps Grok in its own provider-private runtime root", () => {
    const artifact = resolveReviewedGrokArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();

    const launchPath = new ManagedGrokRuntime("/scient-data").launchPath(artifact!);

    expect(launchPath.replaceAll("\\", "/")).toMatch(
      /\/provider-runtimes\/grok\/versions\/1\.0\.5\/darwin-arm64\/grok$/u,
    );
  });
});
