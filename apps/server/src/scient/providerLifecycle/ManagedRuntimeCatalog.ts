/**
 * Process-scoped catalog of qualified managed-provider releases.
 *
 * The remote file may update immutable release facts only. Every packaging,
 * extraction, launch, environment, host, and support decision stays compiled
 * into the app and is re-applied by `hydrateManagedRuntimeArtifact`.
 */
import {
  compareManagedRuntimeVersions,
  hydrateManagedRuntimeArtifact,
  managedRuntimeTargetKey,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeArtifactReceipt,
  type ManagedRuntimeCatalogProvider,
} from "@scientfactory/provider-runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
} from "effect/unstable/http";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { isManagedRuntimeUpdate } from "./managedRuntimeVersion.ts";
import bundledCatalogJson from "./bundled-managed-runtime-catalog.json" with { type: "json" };

export const MANAGED_RUNTIME_CATALOG_URL =
  "https://raw.githubusercontent.com/ScientFactory/scient-desktop/automation/managed-runtime-catalog-v1/apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json";

const CATALOG_TTL_MS = 60 * 60 * 1_000;
const CATALOG_RETRY_MS = 5 * 60 * 1_000;
const CATALOG_POLL_INTERVAL_MS = CATALOG_RETRY_MS;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 2 * 1_024 * 1_024;

const NonEmptyString = (maxLength: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(maxLength)),
  );

const CatalogArtifactSchema = Schema.Struct({
  artifactName: NonEmptyString(512),
  url: NonEmptyString(2_048),
  checksum: Schema.Struct({
    algorithm: Schema.Literals(["sha256", "sha512"]),
    digest: NonEmptyString(128),
  }),
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 * 1_024 * 1_024 * 1_024 })),
  /** ACP ships a verified executable/harness pair; paths and launch policy remain app-owned. */
  antigravityAcp: Schema.optionalKey(
    Schema.Struct({
      version: NonEmptyString(128),
      executableBytes: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: 4 * 1_024 * 1_024 * 1_024 }),
      ),
      harnessBytes: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: 4 * 1_024 * 1_024 * 1_024 }),
      ),
    }),
  ),
});

const CatalogProviderSchema = Schema.Struct({
  contractRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  channel: Schema.Literal("stable"),
  version: NonEmptyString(128),
  artifacts: Schema.Record(Schema.String, CatalogArtifactSchema),
});

export const ManagedRuntimeCatalogDataSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providers: Schema.Record(Schema.String, CatalogProviderSchema),
});
export type ManagedRuntimeCatalogData = typeof ManagedRuntimeCatalogDataSchema.Type;

const CatalogCacheSchema = Schema.Struct({
  fetchedAtMs: Schema.Number,
  etag: Schema.optional(Schema.String),
  catalog: ManagedRuntimeCatalogDataSchema,
});

const decodeCatalog = Schema.decodeUnknownEffect(ManagedRuntimeCatalogDataSchema);
const decodeCatalogJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ManagedRuntimeCatalogDataSchema as unknown as Schema.Codec<ManagedRuntimeCatalogData>,
  ),
);
const decodeCatalogCacheJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    CatalogCacheSchema as unknown as Schema.Codec<typeof CatalogCacheSchema.Type>,
  ),
);
const encodeCatalogCacheJson = Schema.encodeEffect(
  Schema.fromJsonString(
    CatalogCacheSchema as unknown as Schema.Codec<typeof CatalogCacheSchema.Type>,
  ),
);
const decodeBoundedJsonText = Schema.decodeUnknownEffect(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_CATALOG_BYTES))),
);

export const BUNDLED_MANAGED_RUNTIME_CATALOG: ManagedRuntimeCatalogData = Schema.decodeUnknownSync(
  ManagedRuntimeCatalogDataSchema,
)(bundledCatalogJson);

const managedProviders: ReadonlyArray<ManagedRuntimeCatalogProvider> = [
  "codex",
  "claudeAgent",
  "antigravity",
  "antigravityAcp",
  "cursor",
  "droid",
  "grok",
];

/**
 * Merges only strictly newer provider releases. Missing entries, downgrades,
 * contract drift, and same-version repacks never displace a known-good entry.
 */
export function mergeManagedRuntimeCatalogs(
  current: ManagedRuntimeCatalogData,
  candidate: ManagedRuntimeCatalogData,
): ManagedRuntimeCatalogData {
  const providers = { ...current.providers };
  for (const provider of managedProviders) {
    const existing = current.providers[provider];
    const next = candidate.providers[provider];
    if (!existing || !next || next.contractRevision !== existing.contractRevision) continue;
    if (
      compareManagedRuntimeVersions({
        provider,
        current: existing.version,
        candidate: next.version,
      }) === "newer"
    ) {
      providers[provider] = next;
    }
  }
  return { schemaVersion: 1, providers };
}

function normalizedProviderRelease(release: ManagedRuntimeCatalogData["providers"][string]) {
  if (!release) return null;
  return {
    contractRevision: release.contractRevision,
    channel: release.channel,
    version: release.version,
    artifacts: Object.fromEntries(
      Object.entries(release.artifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, artifact]) => [
          target,
          {
            artifactName: artifact.artifactName,
            url: artifact.url,
            checksum: {
              algorithm: artifact.checksum.algorithm,
              digest: artifact.checksum.digest,
            },
            size: artifact.size,
            ...(artifact.antigravityAcp ? { antigravityAcp: artifact.antigravityAcp } : {}),
          },
        ]),
    ),
  };
}

function isSameProviderRelease(
  left: ManagedRuntimeCatalogData["providers"][string],
  right: ManagedRuntimeCatalogData["providers"][string],
): boolean {
  return (
    JSON.stringify(normalizedProviderRelease(left)) ===
    JSON.stringify(normalizedProviderRelease(right))
  );
}

/**
 * Apply an authoritative fetch against both the app floor and current LKG.
 * Explicit version withdrawals are allowed down to the bundled floor, while
 * missing entries, incomparable versions, and same-version repacks retain the
 * current known-good release.
 */
export function resolveFetchedManagedRuntimeCatalog(
  fetched: ManagedRuntimeCatalogData,
  current: ManagedRuntimeCatalogData = BUNDLED_MANAGED_RUNTIME_CATALOG,
): ManagedRuntimeCatalogData {
  const providers = { ...current.providers };
  for (const provider of managedProviders) {
    const bundled = BUNDLED_MANAGED_RUNTIME_CATALOG.providers[provider];
    const existing = current.providers[provider] ?? bundled;
    const candidate = fetched.providers[provider];
    if (
      !bundled ||
      !existing ||
      !candidate ||
      candidate.channel !== "stable" ||
      candidate.contractRevision !== bundled.contractRevision
    ) {
      continue;
    }

    const floorComparison = compareManagedRuntimeVersions({
      provider,
      current: bundled.version,
      candidate: candidate.version,
    });
    if (floorComparison === "older" || floorComparison === "unknown") continue;
    if (floorComparison === "equal" && !isSameProviderRelease(candidate, bundled)) continue;

    const currentComparison = compareManagedRuntimeVersions({
      provider,
      current: existing.version,
      candidate: candidate.version,
    });
    if (currentComparison === "unknown") continue;
    if (currentComparison === "equal" && !isSameProviderRelease(candidate, existing)) continue;
    providers[provider] = candidate;
  }
  return { schemaVersion: 1, providers };
}

function decodeBoundedCatalogJson(raw: string) {
  return decodeBoundedJsonText(raw).pipe(Effect.flatMap(decodeCatalogJson));
}

function decodeBoundedCatalogCacheJson(raw: string) {
  return decodeBoundedJsonText(raw).pipe(Effect.flatMap(decodeCatalogCacheJson));
}

function catalogRevision(input: {
  readonly receipt: Omit<ManagedRuntimeArtifactReceipt, "catalogRevision">;
  readonly contractRevision: number;
}): string {
  const { receipt } = input;
  return [
    "managed-runtime",
    receipt.provider,
    `contract-${input.contractRevision}`,
    receipt.version,
    managedRuntimeTargetKey(receipt.target),
    receipt.checksum.algorithm,
    receipt.checksum.digest,
  ].join(":");
}

/**
 * Resolves one catalog release through a provider policy shipped by this app.
 * Unsupported providers, targets, contract revisions, hosts, or checksum
 * algorithms fail closed without weakening the provider's bundled fallback.
 */
export function resolveManagedRuntimeCatalogArtifact(input: {
  readonly catalog: ManagedRuntimeCatalogData;
  readonly policy: ManagedRuntimeArtifact;
  readonly contractRevision: number;
}): ManagedRuntimeArtifact | undefined {
  const provider = input.catalog.providers[input.policy.provider];
  if (
    !provider ||
    provider.channel !== "stable" ||
    provider.contractRevision !== input.contractRevision
  ) {
    return undefined;
  }
  const release = provider.artifacts[managedRuntimeTargetKey(input.policy.target)];
  if (!release) return undefined;
  const receiptWithoutRevision = {
    provider: input.policy.provider,
    version: provider.version,
    target: input.policy.target,
    artifactName: release.artifactName,
    url: release.url,
    checksum: release.checksum,
    size: release.size,
  } satisfies Omit<ManagedRuntimeArtifactReceipt, "catalogRevision">;
  return hydrateManagedRuntimeArtifact(input.policy, {
    ...receiptWithoutRevision,
    catalogRevision: catalogRevision({
      receipt: receiptWithoutRevision,
      contractRevision: input.contractRevision,
    }),
  });
}

function isSameManagedRuntimeRelease(
  left: ManagedRuntimeArtifact,
  right: ManagedRuntimeArtifact,
): boolean {
  return (
    left.version === right.version &&
    left.artifactName === right.artifactName &&
    left.url === right.url &&
    left.checksum.algorithm === right.checksum.algorithm &&
    left.checksum.digest === right.checksum.digest &&
    left.size === right.size
  );
}

/** Selects only a strictly newer qualified release, never a downgrade or same-version repack. */
export function resolveManagedRuntimeCatalogCandidate(input: {
  readonly catalog: ManagedRuntimeCatalogData;
  readonly bundledArtifact: ManagedRuntimeArtifact | undefined;
  readonly contractRevision: number;
}): ManagedRuntimeArtifact | undefined {
  const { bundledArtifact } = input;
  if (!bundledArtifact) return undefined;
  const remote = resolveManagedRuntimeCatalogArtifact({
    catalog: input.catalog,
    policy: bundledArtifact,
    contractRevision: input.contractRevision,
  });
  if (!remote) return bundledArtifact;
  if (isSameManagedRuntimeRelease(remote, bundledArtifact)) return remote;
  return isManagedRuntimeUpdate({
    provider: bundledArtifact.provider,
    current: bundledArtifact.version,
    candidate: remote.version,
  })
    ? remote
    : bundledArtifact;
}

/** Latest known qualified repair target, including a newer durable installation receipt offline. */
export function resolveManagedRuntimeRepairArtifact(input: {
  readonly bundledArtifact: ManagedRuntimeArtifact | undefined;
  readonly candidateArtifact: ManagedRuntimeArtifact | undefined;
  readonly activeArtifact: ManagedRuntimeArtifactReceipt | null | undefined;
}): ManagedRuntimeArtifact | undefined {
  const candidate = input.candidateArtifact;
  const installed =
    input.bundledArtifact && input.activeArtifact
      ? hydrateManagedRuntimeArtifact(input.bundledArtifact, input.activeArtifact)
      : undefined;
  return installed &&
    (!candidate ||
      isManagedRuntimeUpdate({
        provider: installed.provider,
        current: candidate.version,
        candidate: installed.version,
      }))
    ? installed
    : candidate;
}

export interface ManagedRuntimeCatalogService {
  /** Already-cached catalog; never waits on the network. */
  readonly current: Effect.Effect<ManagedRuntimeCatalogData>;
  /** TTL-gated remote refresh; always falls back to the last good catalog. */
  readonly refresh: Effect.Effect<ManagedRuntimeCatalogData>;
  /** Acquire a process-scoped stream of authoritative catalog changes. */
  readonly subscribeChanges: Effect.Effect<
    Stream.Stream<ManagedRuntimeCatalogChange>,
    never,
    Scope.Scope
  >;
}

export interface ManagedRuntimeCatalogChange {
  readonly catalog: ManagedRuntimeCatalogData;
  readonly changedProviders: ReadonlyArray<ManagedRuntimeCatalogProvider>;
}

const bundledOnlyService: ManagedRuntimeCatalogService = {
  current: Effect.succeed(BUNDLED_MANAGED_RUNTIME_CATALOG),
  refresh: Effect.succeed(BUNDLED_MANAGED_RUNTIME_CATALOG),
  subscribeChanges: Effect.succeed(Stream.empty),
};

/** Bundled-only by default; the production server explicitly provides `layer`. */
export class ManagedRuntimeCatalog extends Context.Reference<ManagedRuntimeCatalogService>(
  "t3/scient/providerLifecycle/ManagedRuntimeCatalog",
  { defaultValue: () => bundledOnlyService },
) {}

export const layerTest = Layer.succeed(ManagedRuntimeCatalog, bundledOnlyService);

export const makeWithOptions = (options?: { readonly startBackgroundRefresh?: boolean }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const serviceScope = yield* Effect.scope;

    const cachePath = path.join(config.stateDir, "managed-runtime-catalog-cache.json");
    let catalog = BUNDLED_MANAGED_RUNTIME_CATALOG;
    let fetchedAtMs: number | null = null;
    let lastAttemptMs: number | null = null;
    let etag: string | null = null;
    const refreshSemaphore = yield* Semaphore.make(1);
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.sliding<ManagedRuntimeCatalogChange>(managedProviders.length),
      PubSub.shutdown,
    );

    const ensureDiskCacheLoaded = yield* Effect.cached(
      Effect.gen(function* () {
        const cached = yield* fileSystem.readFileString(cachePath).pipe(
          Effect.flatMap(decodeBoundedCatalogCacheJson),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (cached === null) return;
        catalog = mergeManagedRuntimeCatalogs(catalog, cached.catalog);
        etag = cached.etag?.trim() || null;
        // Revalidate once per process. This prevents a recent but older cache
        // from delaying a newly bundled catalog or another provider's update.
        fetchedAtMs = null;
      }),
    );

    const persistCache = (now: number) =>
      encodeCatalogCacheJson({
        fetchedAtMs: now,
        ...(etag === null ? {} : { etag }),
        catalog,
      }).pipe(
        Effect.flatMap((contents) =>
          writeFileStringAtomically({ filePath: cachePath, contents, mode: 0o600 }),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause(() => Effect.void),
      );

    const refresh = Effect.fn("ManagedRuntimeCatalog.refresh")(function* () {
      yield* ensureDiskCacheLoaded;
      const now = yield* Clock.currentTimeMillis;
      const isWithin = (sinceMs: number | null, windowMs: number) =>
        sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
      if (isWithin(fetchedAtMs, CATALOG_TTL_MS)) return catalog;
      if (isWithin(lastAttemptMs, CATALOG_RETRY_MS)) return catalog;

      const settings = yield* settingsService.getSettings.pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (settings !== null && !settings.enableProviderUpdateChecks) return catalog;

      lastAttemptMs = now;
      const request = HttpClientRequest.get(MANAGED_RUNTIME_CATALOG_URL).pipe(
        etag === null ? (request_) => request_ : HttpClientRequest.setHeader("if-none-match", etag),
      );
      // One deadline covers headers and body consumption. Interrupting the
      // client response also aborts its request, releasing the refresh lock.
      const fetched = yield* Effect.gen(function* () {
        const response = yield* httpClient.execute(request);
        if (response.status === 304) return { response, data: null };
        yield* HttpClientResponse.filterStatusOk(response);
        const data = yield* response.text.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(MAX_CATALOG_BYTES),
          ),
          Effect.flatMap(decodeBoundedCatalogJson),
        );
        return { response, data };
      }).pipe(
        Effect.timeout(FETCH_TIMEOUT_MS),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fetched === null) return catalog;
      if (fetched.data === null) {
        fetchedAtMs = now;
        yield* persistCache(now);
        return catalog;
      }

      const previous = catalog;
      const next = resolveFetchedManagedRuntimeCatalog(fetched.data, catalog);
      const changedProviders = managedProviders.filter(
        (provider) => previous.providers[provider]?.version !== next.providers[provider]?.version,
      );
      catalog = next;
      etag = fetched.response.headers.etag?.trim() || null;
      fetchedAtMs = now;
      yield* persistCache(now);
      if (changedProviders.length > 0) {
        yield* PubSub.publish(changesPubSub, { catalog, changedProviders });
      }
      return catalog;
    });

    const guardedRefresh = refreshSemaphore.withPermits(1)(refresh());
    if (options?.startBackgroundRefresh !== false) {
      // Acquire the settings subscription before starting either fiber so an
      // enable transition cannot fall into a startup gap.
      const settingsChanges = yield* settingsService.subscribeChanges;
      yield* Effect.forkIn(
        guardedRefresh.pipe(
          Effect.andThen(Effect.sleep(Duration.millis(CATALOG_POLL_INTERVAL_MS))),
          Effect.forever,
        ),
        serviceScope,
      );
      yield* Effect.forkIn(
        settingsChanges.pipe(
          Stream.runForEach((settings) =>
            settings.enableProviderUpdateChecks ? guardedRefresh.pipe(Effect.asVoid) : Effect.void,
          ),
        ),
        serviceScope,
      );
    }
    return ManagedRuntimeCatalog.of({
      current: ensureDiskCacheLoaded.pipe(Effect.map(() => catalog)),
      refresh: guardedRefresh,
      subscribeChanges: PubSub.subscribe(changesPubSub).pipe(Effect.map(Stream.fromSubscription)),
    });
  });

export const make = makeWithOptions();

export const layer = Layer.effect(ManagedRuntimeCatalog, make);

/** Test-only decoder that exercises the same schema as bundle, disk, and network data. */
export const decodeManagedRuntimeCatalog = decodeCatalog;
