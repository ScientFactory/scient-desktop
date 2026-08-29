/**
 * Process-scoped catalog of qualified managed-provider releases.
 *
 * The remote file may update immutable release facts only. Every packaging,
 * extraction, launch, environment, host, and support decision stays compiled
 * into the app and is re-applied by `hydrateManagedRuntimeArtifact`.
 */
import {
  hydrateManagedRuntimeArtifact,
  managedRuntimeTargetKey,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeArtifactReceipt,
} from "@scientfactory/provider-runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse, HttpIncomingMessage } from "effect/unstable/http";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import bundledCatalogJson from "./managed-runtime-catalog.json" with { type: "json" };

export const MANAGED_RUNTIME_CATALOG_URL =
  "https://raw.githubusercontent.com/ScientFactory/scient-desktop/main/apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json";

const CATALOG_TTL_MS = 60 * 60 * 1_000;
const CATALOG_RETRY_MS = 5 * 60 * 1_000;
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

export interface ManagedRuntimeCatalogService {
  /** Already-cached catalog; never waits on the network. */
  readonly current: Effect.Effect<ManagedRuntimeCatalogData>;
  /** TTL-gated remote refresh; always falls back to the last good catalog. */
  readonly refresh: Effect.Effect<ManagedRuntimeCatalogData>;
  /** Starts a process-owned refresh without tying it to a provider request. */
  readonly refreshInBackground: Effect.Effect<void>;
}

const bundledOnlyService: ManagedRuntimeCatalogService = {
  current: Effect.succeed(BUNDLED_MANAGED_RUNTIME_CATALOG),
  refresh: Effect.succeed(BUNDLED_MANAGED_RUNTIME_CATALOG),
  refreshInBackground: Effect.void,
};

/** Bundled-only by default; the production server explicitly provides `layer`. */
export class ManagedRuntimeCatalog extends Context.Reference<ManagedRuntimeCatalogService>(
  "t3/scient/providerLifecycle/ManagedRuntimeCatalog",
  { defaultValue: () => bundledOnlyService },
) {}

export const layerTest = Layer.succeed(ManagedRuntimeCatalog, bundledOnlyService);

export const make = Effect.gen(function* () {
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
  const refreshSemaphore = yield* Semaphore.make(1);

  const ensureDiskCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const cached = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap(decodeBoundedCatalogCacheJson),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (cached === null) return;
      catalog = cached.catalog;
      fetchedAtMs = cached.fetchedAtMs;
    }),
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
    const fetched = yield* httpClient.get(MANAGED_RUNTIME_CATALOG_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(MAX_CATALOG_BYTES),
          ),
        ),
      ),
      Effect.flatMap(decodeBoundedCatalogJson),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) return catalog;

    catalog = fetched;
    fetchedAtMs = now;
    yield* encodeCatalogCacheJson({ fetchedAtMs: now, catalog: fetched }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: cachePath, contents, mode: 0o600 }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.void),
    );
    return catalog;
  });

  const guardedRefresh = refreshSemaphore.withPermits(1)(refresh());
  return ManagedRuntimeCatalog.of({
    current: ensureDiskCacheLoaded.pipe(Effect.map(() => catalog)),
    refresh: guardedRefresh,
    refreshInBackground: Effect.forkIn(guardedRefresh, serviceScope).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ManagedRuntimeCatalog, make);

/** Test-only decoder that exercises the same schema as bundle, disk, and network data. */
export const decodeManagedRuntimeCatalog = decodeCatalog;
