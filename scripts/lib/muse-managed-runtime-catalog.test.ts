import { describe, expect, it } from "vite-plus/test";
import {
  MUSE_DOWNLOAD_URL,
  MUSE_STABLE_CHANNEL_URL,
  MUSE_TARGETS,
  resolveMuseArtifactPolicy,
} from "@scientfactory/provider-runtime";
import {
  refreshManagedRuntimeProvider,
  validateManagedRuntimeCandidate,
  type ManagedRuntimeCatalogData,
} from "./managed-runtime-catalog.ts";
import bundledCatalogJson from "../../apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };

const empty: ManagedRuntimeCatalogData = { schemaVersion: 1, providers: {} };
// Discovery never moves below the bundled floor; R10 must follow R9 numerically.
const version = bundledCatalogJson.providers.muse.version.replace(
  /-R(\d+)/u,
  (_, revision: string) => `-R${Number(revision) * 10}`,
);
const manifestUrl = `${MUSE_DOWNLOAD_URL}?channel=muse&version=${version}&file=manifest.json`;
const channel = { channel: "muse-stable", state: "public", version, manifest_url: manifestUrl };
const manifest = {
  version,
  checksum_algorithm: "sha256",
  artifacts: Object.fromEntries(
    MUSE_TARGETS.map((target) => {
      const { artifactName } = resolveMuseArtifactPolicy(target)!;
      const key = artifactName.replace("muse-", "").replace(".exe", "").replace("-", "_");
      return [
        key,
        {
          url: `${MUSE_DOWNLOAD_URL}?channel=muse&version=${version}&file=${artifactName}`,
          checksum: "a".repeat(64),
          size: 463_719_160,
        },
      ];
    }),
  ),
};

const fetchFixture =
  (overrides: { channel?: unknown; manifest?: unknown } = {}) =>
  async (url: URL) => {
    if (url.toString() === MUSE_STABLE_CHANNEL_URL)
      return Response.json(overrides.channel ?? channel);
    expect(url.toString()).toBe(manifestUrl);
    return Response.json(overrides.manifest ?? manifest);
  };

describe("Muse stable release discovery", () => {
  it("requires six complete exact-target artifacts without downloading installers", async () => {
    const result = await refreshManagedRuntimeProvider(empty, "muse", fetchFixture());
    expect(result.changedProviders).toEqual(["muse"]);
    const candidate = validateManagedRuntimeCandidate(result.catalog, "muse");
    expect(candidate.version).toBe(version);
    expect(Object.keys(candidate.artifacts).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-glibc",
      "linux-x64-glibc",
      "win32-arm64",
      "win32-x64",
    ]);
    expect(empty.providers.muse).toBeUndefined();
  });

  it.each([
    { channel: { ...channel, state: "private" } },
    { channel: { ...channel, channel: "muse-canary" } },
    { channel: { ...channel, manifest_url: "https://example.test/manifest.json" } },
    { manifest: { ...manifest, version: `${version}9` } },
    { manifest: { ...manifest, checksum_algorithm: "sha512" } },
    { manifest: { ...manifest, artifacts: {} } },
    {
      manifest: {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          x86_windows: { ...manifest.artifacts.x86_windows, size: 600 * 1024 * 1024 },
        },
      },
    },
    {
      manifest: {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          aarch64_macos: {
            ...manifest.artifacts.aarch64_macos,
            url: `${MUSE_DOWNLOAD_URL}?channel=canary&version=${version}&file=muse-aarch64-macos`,
          },
        },
      },
    },
  ])("rejects inconsistent stable metadata %j", async (overrides) => {
    await expect(
      refreshManagedRuntimeProvider(empty, "muse", fetchFixture(overrides)),
    ).rejects.toThrow();
  });
});
