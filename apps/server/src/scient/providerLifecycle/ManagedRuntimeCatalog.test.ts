import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveReviewedCodexArtifact,
  type ManagedRuntimeTarget,
} from "@scientfactory/provider-runtime";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  BUNDLED_MANAGED_RUNTIME_CATALOG,
  make,
  resolveManagedRuntimeCatalogArtifact,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";

const targets: ReadonlyArray<ManagedRuntimeTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "arm64", libc: "musl" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "musl" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

const remoteCatalog = (version = "0.150.0"): ManagedRuntimeCatalogData => ({
  schemaVersion: 1,
  providers: {
    codex: {
      contractRevision: 1,
      channel: "stable",
      version,
      artifacts: {
        ...BUNDLED_MANAGED_RUNTIME_CATALOG.providers.codex?.artifacts,
        "darwin-arm64": {
          artifactName: `codex-${version}-darwin-arm64.tar.gz`,
          url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${version}-darwin-arm64.tar.gz`,
          checksum: { algorithm: "sha256", digest: "a".repeat(64) },
          size: 123_456,
        },
      },
    },
  },
});

const httpClientLayer = (handler: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler()))),
  );

const serviceLayers = (input: {
  readonly prefix: string;
  readonly response: () => Response;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(httpClientLayer(input.response)),
  );

describe("managed runtime catalog resolution", () => {
  it("keeps release facts synchronized with every bundled Codex target", () => {
    for (const target of targets) {
      const policy = resolveReviewedCodexArtifact(target);
      assert.isDefined(policy);
      const resolved = resolveManagedRuntimeCatalogArtifact({
        catalog: BUNDLED_MANAGED_RUNTIME_CATALOG,
        policy,
        contractRevision: 1,
      });
      assert.isDefined(resolved);
      assert.strictEqual(resolved.version, policy.version);
      assert.strictEqual(resolved.artifactName, policy.artifactName);
      assert.strictEqual(resolved.url, policy.url);
      assert.deepStrictEqual(resolved.checksum, policy.checksum);
      assert.strictEqual(resolved.size, policy.size);
      assert.strictEqual(resolved.executablePath, policy.executablePath);
      assert.deepStrictEqual(resolved.auxiliaryExecutablePaths, policy.auxiliaryExecutablePaths);
    }
  });

  it("updates release facts without widening app-owned execution policy", () => {
    const policy = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
    assert.isDefined(policy);
    const resolved = resolveManagedRuntimeCatalogArtifact({
      catalog: remoteCatalog(),
      policy,
      contractRevision: 1,
    });
    assert.isDefined(resolved);
    assert.strictEqual(resolved.version, "0.150.0");
    assert.strictEqual(resolved.size, 123_456);
    assert.strictEqual(resolved.archiveFormat, policy.archiveFormat);
    assert.strictEqual(resolved.executablePath, policy.executablePath);
    assert.deepStrictEqual(resolved.smokeArgs, policy.smokeArgs);
    assert.deepStrictEqual(resolved.allowedHosts, policy.allowedHosts);
    assert.strictEqual(resolved.supportTier, policy.supportTier);
  });

  it("fails closed for stale contracts and unapproved hosts", () => {
    const policy = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
    assert.isDefined(policy);
    assert.isUndefined(
      resolveManagedRuntimeCatalogArtifact({
        catalog: remoteCatalog(),
        policy,
        contractRevision: 2,
      }),
    );
    const catalog = remoteCatalog();
    const codex = catalog.providers.codex;
    assert.isDefined(codex);
    const artifact = codex.artifacts["darwin-arm64"];
    assert.isDefined(artifact);
    assert.isUndefined(
      resolveManagedRuntimeCatalogArtifact({
        catalog: {
          ...catalog,
          providers: {
            codex: {
              ...codex,
              artifacts: {
                ...codex.artifacts,
                "darwin-arm64": { ...artifact, url: "https://example.com/codex.tar.gz" },
              },
            },
          },
        },
        policy,
        contractRevision: 1,
      }),
    );
  });
});

describe("ManagedRuntimeCatalog service", () => {
  it.live("prefers a valid remote catalog and restores it from the atomic disk cache", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const service = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json(remoteCatalog());
          }),
        ),
      );
      const refreshed = yield* service.refresh;
      assert.strictEqual(refreshed.providers.codex?.version, "0.150.0");
      assert.strictEqual(fetchCount, 1);

      const rebooted = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json({ schemaVersion: 999 });
          }),
        ),
      );
      assert.strictEqual((yield* rebooted.current).providers.codex?.version, "0.150.0");
      assert.strictEqual(fetchCount, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "managed-runtime-catalog-fetch-test",
          response: () => Response.json(remoteCatalog()),
        }),
      ),
    ),
  );

  it.live("keeps the bundled catalog when remote data is malformed", () =>
    Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MANAGED_RUNTIME_CATALOG);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "managed-runtime-catalog-malformed-test",
          response: () => Response.json({ schemaVersion: 999, providers: {} }),
        }),
      ),
    ),
  );

  it.live("does not fetch when provider update checks are disabled", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const service = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json(remoteCatalog());
          }),
        ),
      );
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MANAGED_RUNTIME_CATALOG);
      assert.strictEqual(fetchCount, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "managed-runtime-catalog-optout-test",
          response: () => Response.json(remoteCatalog()),
          settings: { enableProviderUpdateChecks: false },
        }),
      ),
    ),
  );
});
