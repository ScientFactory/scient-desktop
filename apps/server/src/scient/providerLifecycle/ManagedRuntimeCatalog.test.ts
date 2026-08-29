import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveReviewedAntigravityArtifact,
  resolveReviewedClaudeArtifact,
  resolveReviewedCodexArtifact,
  resolveReviewedCursorArtifact,
  resolveReviewedDroidArtifact,
  resolveReviewedGrokArtifact,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeProvider,
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
  mergeManagedRuntimeCatalogs,
  resolveManagedRuntimeCatalogArtifact,
  resolveManagedRuntimeCatalogCandidate,
  resolveFetchedManagedRuntimeCatalog,
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

const policies: ReadonlyArray<{
  readonly provider: ManagedRuntimeProvider;
  readonly resolve: (target: ManagedRuntimeTarget) => ManagedRuntimeArtifact | undefined;
}> = [
  { provider: "codex", resolve: resolveReviewedCodexArtifact },
  { provider: "claudeAgent", resolve: resolveReviewedClaudeArtifact },
  { provider: "antigravity", resolve: resolveReviewedAntigravityArtifact },
  { provider: "cursor", resolve: resolveReviewedCursorArtifact },
  { provider: "droid", resolve: resolveReviewedDroidArtifact },
  { provider: "grok", resolve: resolveReviewedGrokArtifact },
];

const remoteCatalog = (version = "0.151.0"): ManagedRuntimeCatalogData => ({
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
  it("never lets an older cache outrank a newer bundled provider release", () => {
    const bundled = BUNDLED_MANAGED_RUNTIME_CATALOG;
    const codex = bundled.providers.codex;
    const claude = bundled.providers.claudeAgent;
    assert.isDefined(codex);
    assert.isDefined(claude);
    const merged = mergeManagedRuntimeCatalogs(bundled, {
      schemaVersion: 1,
      providers: {
        codex: { ...codex, version: "0.149.1" },
        claudeAgent: { ...claude, version: "2.1.252" },
      },
    });
    assert.strictEqual(merged.providers.codex?.version, codex.version);
    assert.strictEqual(merged.providers.claudeAgent?.version, "2.1.252");
    assert.isDefined(merged.providers.antigravity);
  });

  it("ignores same-version repacks and contract drift", () => {
    const bundled = BUNDLED_MANAGED_RUNTIME_CATALOG;
    const codex = bundled.providers.codex;
    assert.isDefined(codex);
    const darwin = codex.artifacts["darwin-arm64"];
    assert.isDefined(darwin);
    const repacked = mergeManagedRuntimeCatalogs(bundled, {
      schemaVersion: 1,
      providers: {
        codex: {
          ...codex,
          artifacts: {
            ...codex.artifacts,
            "darwin-arm64": {
              ...darwin,
              checksum: { algorithm: "sha256", digest: "e".repeat(64) },
            },
          },
        },
      },
    });
    assert.deepStrictEqual(repacked.providers.codex, codex);
    const contractDrift = mergeManagedRuntimeCatalogs(bundled, {
      schemaVersion: 1,
      providers: { codex: { ...codex, contractRevision: 2, version: "0.151.0" } },
    });
    assert.deepStrictEqual(contractDrift.providers.codex, codex);
  });

  it("lets the authoritative catalog withdraw a cached release without undercutting the app bundle", () => {
    const bundled = BUNDLED_MANAGED_RUNTIME_CATALOG;
    const codex = bundled.providers.codex;
    assert.isDefined(codex);
    const fetched = resolveFetchedManagedRuntimeCatalog({
      schemaVersion: 1,
      providers: { codex: { ...codex, version: "0.151.0" } },
    });
    assert.strictEqual(fetched.providers.codex?.version, "0.151.0");

    const withdrawn = resolveFetchedManagedRuntimeCatalog({
      schemaVersion: 1,
      providers: { codex: { ...codex, version: codex.version } },
    });
    assert.strictEqual(withdrawn.providers.codex?.version, codex.version);
    assert.isDefined(withdrawn.providers.claudeAgent);

    const undercut = resolveFetchedManagedRuntimeCatalog({
      schemaVersion: 1,
      providers: { codex: { ...codex, version: "0.149.1" } },
    });
    assert.strictEqual(undercut.providers.codex?.version, codex.version);
  });

  it("keeps release facts synchronized with every bundled provider target", () => {
    for (const { provider, resolve } of policies) {
      for (const target of targets) {
        const policy = resolve(target);
        if (!policy) continue;
        const resolved = resolveManagedRuntimeCatalogArtifact({
          catalog: BUNDLED_MANAGED_RUNTIME_CATALOG,
          policy,
          contractRevision: 1,
        });
        assert.isDefined(resolved, `${provider} ${JSON.stringify(target)}`);
        assert.strictEqual(
          resolved.version,
          BUNDLED_MANAGED_RUNTIME_CATALOG.providers[provider]?.version,
        );
        assert.strictEqual(resolved.executablePath, policy.executablePath);
        assert.deepStrictEqual(resolved.auxiliaryExecutablePaths, policy.auxiliaryExecutablePaths);
        assert.deepStrictEqual(resolved.smokeArgs, policy.smokeArgs);
        assert.deepStrictEqual(resolved.allowedHosts, policy.allowedHosts);
      }
    }
  });

  it("selects only strictly newer catalog releases for every provider policy", () => {
    const policy = resolveReviewedClaudeArtifact({ platform: "darwin", arch: "arm64" });
    assert.isDefined(policy);
    const current = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.claudeAgent;
    assert.isDefined(current);
    const release = current.artifacts["darwin-arm64"];
    assert.isDefined(release);
    const candidate = resolveManagedRuntimeCatalogCandidate({
      bundledArtifact: policy,
      contractRevision: 1,
      catalog: {
        schemaVersion: 1,
        providers: {
          claudeAgent: {
            ...current,
            version: "2.1.252",
            artifacts: {
              ...current.artifacts,
              "darwin-arm64": {
                ...release,
                artifactName: "claude-2.1.252-darwin-arm64",
                url: "https://downloads.claude.ai/claude-code-releases/2.1.252/darwin-arm64/claude",
                checksum: { algorithm: "sha256", digest: "c".repeat(64) },
              },
            },
          },
        },
      },
    });
    assert.strictEqual(candidate?.version, "2.1.252");

    const sameVersionRepack = resolveManagedRuntimeCatalogCandidate({
      bundledArtifact: policy,
      contractRevision: 1,
      catalog: {
        schemaVersion: 1,
        providers: {
          claudeAgent: {
            ...current,
            version: policy.version,
            artifacts: {
              ...current.artifacts,
              "darwin-arm64": {
                ...release,
                checksum: { algorithm: "sha256", digest: "d".repeat(64) },
              },
            },
          },
        },
      },
    });
    assert.strictEqual(sameVersionRepack, policy);
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
    assert.strictEqual(resolved.version, "0.151.0");
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
      assert.strictEqual(refreshed.providers.codex?.version, "0.151.0");
      assert.strictEqual(fetchCount, 1);

      const rebooted = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json({ schemaVersion: 999 });
          }),
        ),
      );
      assert.strictEqual((yield* rebooted.current).providers.codex?.version, "0.151.0");
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
