import { expect, it } from "@effect/vitest";

import catalog from "./managed-runtime-catalog.json" with { type: "json" };
import {
  bundledAntigravityAcpAsset,
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
    expect(resolveAntigravityAcpCatalogAsset(catalog, platform, arch)).toEqual(
      bundledAntigravityAcpAsset(platform, arch),
    );
  }
  expect(resolveAntigravityAcpCatalogAsset(catalog, "darwin", "x64")).toBeUndefined();
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
