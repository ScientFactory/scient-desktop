import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  managedRuntimeArtifactReceipt,
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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  BUNDLED_MANAGED_RUNTIME_CATALOG,
  makeWithOptions,
  mergeManagedRuntimeCatalogs,
  resolveManagedRuntimeCatalogArtifact,
  resolveManagedRuntimeCatalogCandidate,
  resolveManagedRuntimeRepairArtifact,
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

function nextPatch(version: string): string {
  const match = /^(.*\.)([0-9]+)$/u.exec(version);
  if (!match) throw new Error(`Test version '${version}' has no numeric patch component.`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

const bundledCodexVersion = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.codex?.version;
if (!bundledCodexVersion) throw new Error("Bundled Codex catalog release is missing.");
const newerCodexVersion = nextPatch(bundledCodexVersion);

const remoteCatalog = (version = newerCodexVersion): ManagedRuntimeCatalogData => ({
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

const httpClientLayer = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

const serviceLayers = (input: {
  readonly prefix: string;
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
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
        codex: { ...codex, version: "0.0.1" },
        claudeAgent: { ...claude, version: nextPatch(claude.version) },
      },
    });
    assert.strictEqual(merged.providers.codex?.version, codex.version);
    assert.strictEqual(merged.providers.claudeAgent?.version, nextPatch(claude.version));
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
      providers: { codex: { ...codex, contractRevision: 2, version: newerCodexVersion } },
    });
    assert.deepStrictEqual(contractDrift.providers.codex, codex);
  });

  it("lets the authoritative catalog withdraw a cached release without undercutting the app bundle", () => {
    const bundled = BUNDLED_MANAGED_RUNTIME_CATALOG;
    const codex = bundled.providers.codex;
    assert.isDefined(codex);
    const fetched = resolveFetchedManagedRuntimeCatalog(remoteCatalog(), bundled);
    assert.strictEqual(fetched.providers.codex?.version, newerCodexVersion);

    const withdrawn = resolveFetchedManagedRuntimeCatalog(
      { schemaVersion: 1, providers: { codex } },
      fetched,
    );
    assert.strictEqual(withdrawn.providers.codex?.version, codex.version);
    assert.isDefined(withdrawn.providers.claudeAgent);

    const undercut = resolveFetchedManagedRuntimeCatalog(
      { schemaVersion: 1, providers: { codex: { ...codex, version: "0.0.1" } } },
      fetched,
    );
    assert.strictEqual(undercut.providers.codex?.version, newerCodexVersion);
  });

  it("retains the current release for same-version repacks and missing entries", () => {
    const current = remoteCatalog();
    const codex = current.providers.codex;
    assert.isDefined(codex);
    const darwin = codex.artifacts["darwin-arm64"];
    assert.isDefined(darwin);
    const repacked = resolveFetchedManagedRuntimeCatalog(
      {
        schemaVersion: 1,
        providers: {
          codex: {
            ...codex,
            artifacts: {
              ...codex.artifacts,
              "darwin-arm64": {
                ...darwin,
                checksum: { ...darwin.checksum, digest: "f".repeat(64) },
              },
            },
          },
        },
      },
      current,
    );
    assert.deepStrictEqual(repacked.providers.codex, codex);
    assert.deepStrictEqual(
      resolveFetchedManagedRuntimeCatalog({ schemaVersion: 1, providers: {} }, current).providers
        .codex,
      codex,
    );
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
    const newerVersion = nextPatch(current.version);
    const candidate = resolveManagedRuntimeCatalogCandidate({
      bundledArtifact: policy,
      contractRevision: 1,
      catalog: {
        schemaVersion: 1,
        providers: {
          claudeAgent: {
            ...current,
            version: newerVersion,
            artifacts: {
              ...current.artifacts,
              "darwin-arm64": {
                ...release,
                artifactName: `claude-${newerVersion}-darwin-arm64`,
                url: `https://downloads.claude.ai/claude-code-releases/${newerVersion}/darwin-arm64/claude`,
                checksum: { algorithm: "sha256", digest: "c".repeat(64) },
              },
            },
          },
        },
      },
    });
    assert.strictEqual(candidate?.version, newerVersion);

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
    assert.strictEqual(resolved.version, newerCodexVersion);
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
      const service = yield* makeWithOptions({ startBackgroundRefresh: false }).pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json(remoteCatalog());
          }),
        ),
      );
      const refreshed = yield* service.refresh;
      assert.strictEqual(refreshed.providers.codex?.version, newerCodexVersion);
      assert.strictEqual(fetchCount, 1);

      const rebooted = yield* makeWithOptions({ startBackgroundRefresh: false }).pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json({ schemaVersion: 999 });
          }),
        ),
      );
      assert.strictEqual((yield* rebooted.current).providers.codex?.version, newerCodexVersion);
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
      const service = yield* makeWithOptions({ startBackgroundRefresh: false });
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
      const service = yield* makeWithOptions({ startBackgroundRefresh: false }).pipe(
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

  it.live("uses an ETag to revalidate the last good catalog without redownloading it", () =>
    Effect.gen(function* () {
      const requests: Array<string | undefined> = [];
      const first = yield* makeWithOptions({ startBackgroundRefresh: false }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            requests.push(request.headers["if-none-match"]);
            return Response.json(remoteCatalog(), { headers: { etag: '"catalog-v1"' } });
          }),
        ),
      );
      yield* first.refresh;

      const rebooted = yield* makeWithOptions({ startBackgroundRefresh: false }).pipe(
        Effect.provide(
          httpClientLayer((request) => {
            requests.push(request.headers["if-none-match"]);
            return new Response(null, { status: 304, headers: { etag: '"catalog-v1"' } });
          }),
        ),
      );
      const refreshed = yield* rebooted.refresh;
      assert.strictEqual(refreshed.providers.codex?.version, newerCodexVersion);
      assert.deepStrictEqual(requests, [undefined, '"catalog-v1"']);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "managed-runtime-catalog-etag-test",
          response: () => Response.json(remoteCatalog()),
        }),
      ),
    ),
  );

  it.live("emits the exact provider whose qualified release changed", () =>
    Effect.gen(function* () {
      const service = yield* makeWithOptions({ startBackgroundRefresh: false });
      const changes = yield* service.subscribeChanges;
      yield* service.refresh;
      const change = Option.getOrThrow(yield* changes.pipe(Stream.runHead));
      assert.deepStrictEqual(change.changedProviders, ["codex"]);
      assert.strictEqual(change.catalog.providers.codex?.version, newerCodexVersion);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "managed-runtime-catalog-change-test",
          response: () => Response.json(remoteCatalog()),
        }),
      ),
    ),
  );
});

describe("latest qualified repair selection", () => {
  for (const { provider, resolve } of policies) {
    it(`repairs latest for ${provider} and never downgrades a newer compatible receipt offline`, () => {
      const bundled = resolve({ platform: "darwin", arch: "arm64" });
      assert.isDefined(bundled);
      const candidate = resolveManagedRuntimeCatalogCandidate({
        bundledArtifact: bundled,
        catalog: BUNDLED_MANAGED_RUNTIME_CATALOG,
        contractRevision: 1,
      });
      assert.isDefined(candidate);
      const newer = {
        ...candidate,
        version: provider === "cursor" ? "2099.01.01-abcdef0" : "99.0.0",
        catalogRevision: "fixture-newer",
      };
      assert.strictEqual(
        resolveManagedRuntimeRepairArtifact({
          bundledArtifact: bundled,
          candidateArtifact: newer,
          activeArtifact: managedRuntimeArtifactReceipt(candidate),
        }),
        newer,
      );
      assert.strictEqual(
        resolveManagedRuntimeRepairArtifact({
          bundledArtifact: bundled,
          candidateArtifact: candidate,
          activeArtifact: undefined,
        }),
        candidate,
      );
      assert.equal(
        resolveManagedRuntimeRepairArtifact({
          bundledArtifact: bundled,
          candidateArtifact: candidate,
          activeArtifact: managedRuntimeArtifactReceipt(newer),
        })?.version,
        newer.version,
      );
      assert.strictEqual(
        resolveManagedRuntimeRepairArtifact({
          bundledArtifact: bundled,
          candidateArtifact: candidate,
          activeArtifact: {
            ...managedRuntimeArtifactReceipt(newer),
            url: "https://untrusted.example/runtime",
          },
        }),
        candidate,
      );
    });
  }
});
