import { expect, it } from "@effect/vitest";

import catalog from "./bundled-managed-runtime-catalog.json" with { type: "json" };
import {
  bundledAntigravityAcpAsset,
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  resolveAntigravityAcpCatalogAsset,
} from "./antigravityAcpCatalog.ts";

const targets = [
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
] as const;

it("hydrates only the five app-owned ACP targets and preserves the bundled release floor", () => {
  for (const [platform, arch] of targets) {
    const asset = resolveAntigravityAcpCatalogAsset(catalog, platform, arch);
    expect(asset?.registryVersion).toBe(catalog.providers.antigravityAcp.version);
    expect(asset?.sha256).toBe(
      catalog.providers.antigravityAcp.artifacts[
        `${platform}-${arch}` as keyof typeof catalog.providers.antigravityAcp.artifacts
      ].checksum.digest,
    );
    const bundled = bundledAntigravityAcpAsset(platform, arch);
    expect(bundled?.registryVersion).toBe(ANTIGRAVITY_ACP_REGISTRY_VERSION);
    expect(bundled?.version).toBe("agy_acp_server_1.1.1");
    expect(bundled?.sha256).toBe(asset?.sha256);
  }
  expect(resolveAntigravityAcpCatalogAsset(catalog, "darwin", "x64")).toBeUndefined();
});

it.each(["1.0.0", "1.1.0"])(
  "does not let an older %s catalog override the bundled ACP release",
  (version) => {
    const staleCatalog = {
      ...catalog,
      providers: {
        ...catalog.providers,
        antigravityAcp: { ...catalog.providers.antigravityAcp, version },
      },
    };
    for (const [platform, arch] of targets) {
      expect(resolveAntigravityAcpCatalogAsset(staleCatalog, platform, arch)).toBeUndefined();
      expect(bundledAntigravityAcpAsset(platform, arch)?.registryVersion).toBe("1.1.1");
    }
  },
);

it("rejects feed attempts to change the approved ACP host, member facts, or release order", () => {
  const release = catalog.providers.antigravityAcp;
  const artifact = release.artifacts["linux-x64"];
  const resolve = (override: unknown) =>
    resolveAntigravityAcpCatalogAsset(override as typeof catalog, "linux", "x64");

  expect(
    resolve({
      ...catalog,
      providers: {
        ...catalog.providers,
        antigravityAcp: {
          ...release,
          artifacts: {
            ...release.artifacts,
            "linux-x64": { ...artifact, url: "https://example.com/runtime.zip" },
          },
        },
      },
    }),
  ).toBeUndefined();
  expect(
    resolve({
      ...catalog,
      providers: {
        ...catalog.providers,
        antigravityAcp: {
          ...release,
          version: "0.9.0",
        },
      },
    }),
  ).toBeUndefined();
  expect(
    resolve({
      ...catalog,
      providers: {
        ...catalog.providers,
        antigravityAcp: {
          ...release,
          artifacts: {
            ...release.artifacts,
            "linux-x64": {
              ...artifact,
              antigravityAcp: { ...artifact.antigravityAcp, harnessBytes: 0 },
            },
          },
        },
      },
    }),
  ).toBeUndefined();
});
