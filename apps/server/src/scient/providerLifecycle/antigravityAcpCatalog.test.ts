import { expect, it } from "@effect/vitest";

import catalog from "./bundled-managed-runtime-catalog.json" with { type: "json" };
import {
  bundledAntigravityAcpAsset,
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  resolveAntigravityAcpCatalogAsset,
  resolveAntigravityCliCatalogAsset,
} from "./antigravityAcpCatalog.ts";
import {
  BUNDLED_MANAGED_RUNTIME_CATALOG,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";
import { selectAntigravityManagedRelease } from "./ScientAntigravityInstallation.ts";

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
    expect(bundled?.version).toBe("1.4.5");
    expect(bundled?.sha256).toBe(asset?.sha256);
    expect(bundled).toEqual(asset);
  }
  expect(resolveAntigravityAcpCatalogAsset(catalog, "darwin", "x64")).toBeUndefined();
  expect(bundledAntigravityAcpAsset("darwin", "x64")).toBeNull();
});

it.each(["1.0.0", "1.2.0"])(
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
      expect(bundledAntigravityAcpAsset(platform, arch)?.registryVersion).toBe("1.4.5");
    }
  },
);

it.each([
  "latest",
  "1.3",
  "1.3.0/other",
  "../1.3.0",
  "agy_acp_server_",
  `agy_acp_server_${"a".repeat(97)}`,
])("rejects malformed native release identity %s", (version) => {
  const release = catalog.providers.antigravityAcp;
  const artifact = release.artifacts["linux-x64"];
  expect(
    resolveAntigravityAcpCatalogAsset(
      {
        ...catalog,
        providers: {
          ...catalog.providers,
          antigravityAcp: {
            ...release,
            artifacts: {
              ...release.artifacts,
              "linux-x64": {
                ...artifact,
                artifactName: `agy-acp-server-${version}-linux-x86_64.zip`,
                url: `https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${version}-linux-x86_64.zip`,
                antigravityAcp: { ...artifact.antigravityAcp, version },
              },
            },
          },
        },
      },
      "linux",
      "x64",
    ),
  ).toBeUndefined();
});

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

const bundledCli = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.antigravity!;
const withCli = (
  version: string,
  url: (url: string) => string = (value) =>
    value.replace(/antigravity-cli\/[^/]+\//u, `antigravity-cli/${version}-5302690847260672/`),
): ManagedRuntimeCatalogData => ({
  ...BUNDLED_MANAGED_RUNTIME_CATALOG,
  providers: {
    ...BUNDLED_MANAGED_RUNTIME_CATALOG.providers,
    antigravity: {
      ...bundledCli,
      version,
      artifacts: Object.fromEntries(
        Object.entries(bundledCli.artifacts).map(([key, artifact]) => [
          key,
          { ...artifact, url: url(artifact.url) },
        ]),
      ),
    },
  },
});

it("makes the catalog's ACP-capable agy CLI the managed default on every ACP target", () => {
  const served = withCli("1.5.14");
  for (const [platform, arch] of targets) {
    const key = platform === "linux" ? `${platform}-${arch}-glibc` : `${platform}-${arch}`;
    const artifact = served.providers.antigravity!.artifacts[key]!;
    const selected = selectAntigravityManagedRelease(served, platform, arch, false);
    expect(selected).toEqual({
      version: "1.5.14",
      url: artifact.url,
      sha512: artifact.checksum.digest,
      archiveBytes: artifact.size,
      executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
      format: platform === "win32" ? "executable" : "tar.gz",
    });
  }
  // Intel Macs keep the legacy backend: the CLI is not offered to the ACP driver there.
  expect(resolveAntigravityCliCatalogAsset(served, "darwin", "x64")).toBeUndefined();
});

it("keeps the paired release as the floor where no qualified CLI is listed", () => {
  const paired = (platform: NodeJS.Platform, arch: string) =>
    resolveAntigravityAcpCatalogAsset(BUNDLED_MANAGED_RUNTIME_CATALOG, platform, arch);
  // The bundled catalog's 1.1.x CLI cannot serve ACP, so offline installs stay paired.
  for (const [platform, arch] of targets) {
    expect(
      selectAntigravityManagedRelease(BUNDLED_MANAGED_RUNTIME_CATALOG, platform, arch, false),
    ).toEqual(paired(platform, arch));
  }
  expect(selectAntigravityManagedRelease(withCli("1.5.11"), "linux", "x64", false)).toEqual(
    paired("linux", "x64"),
  );
  // Google publishes no reviewed musl CLI.
  expect(selectAntigravityManagedRelease(withCli("1.5.14"), "linux", "x64", true)).toEqual(
    paired("linux", "x64"),
  );
  expect(
    selectAntigravityManagedRelease(
      withCli("1.5.14", (url) => url.replace("storage.googleapis.com", "example.com")),
      "linux",
      "x64",
      false,
    ),
  ).toEqual(paired("linux", "x64"));
});
