import type { ManagedRuntimeArtifact } from "./managedRuntimeArtifact.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

/** Only the locally qualified native target is offered for managed installation. */
export function resolveReviewedPiArtifact(
  target: ManagedRuntimeTarget,
): ManagedRuntimeArtifact | undefined {
  if (target.platform !== "darwin" || target.arch !== "arm64") return undefined;
  const digest = "c68e3ac4d05b4e282aaab2e6c76f161d3e9e68f19a22e38913cbfaadb6c800f0";
  return {
    provider: "pi",
    version: "0.84.4",
    target,
    artifactName: "pi-darwin-arm64.tar.gz",
    url: "https://github.com/earendil-works/pi/releases/download/v0.84.4/pi-darwin-arm64.tar.gz",
    allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
    allowedUrlPathPrefixes: ["/earendil-works/pi/releases/download/"],
    checksum: { algorithm: "sha256", digest },
    size: 30_928_407,
    archiveFormat: "tar.gz",
    // Pi 0.84.4 contains 247 entries (binary, docs, examples). Keep the shared
    // archive validation and bounded headroom; do not raise other providers' limits.
    extractionLimits: { maxEntries: 512, maxExpandedBytes: 256 * 1024 * 1024 },
    executablePath: "pi/pi",
    smokeArgs: ["--version"],
    smokeEnvironment: { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
    catalogRevision: `pi:0.84.4:darwin-arm64:${digest}`,
    supportTier: "fully_assisted",
    supportMessage:
      "Scient can install this qualified official Pi runtime privately. Model credentials are configured with Pi.",
  };
}
