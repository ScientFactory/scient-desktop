/**
 * One-click connectors require active Streamable HTTP over HTTPS with no user-supplied headers or
 * URL variables. Keep curated icons bundled; see docs/internals/scient-extensions.md.
 */
import {
  ExtensionsError,
  type ConnectorId,
  type DiscoverCatalog,
  type DiscoverCatalogSection,
  type DiscoverEntry,
  type DiscoverPage,
  type DiscoverRemote,
  type ExtensionCategory,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import {
  ConnectorRuntime,
  ExtensionsDiscover,
  type ExtensionsDiscoverShape,
} from "../ExtensionsServices.ts";
import {
  canonicalConnectorUrl,
  CATALOG_CATEGORY_ORDER,
  CATALOG_SECTIONS,
  CURATED_NAME_PREFIX,
  CURATED_SERVERS,
  curatedDiscoverEntry,
  curatedServerForUrl,
  type CuratedServer,
} from "./curatedCatalog.ts";

export const MCP_REGISTRY_SERVERS_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";
const DISCOVER_CACHE_TTL = Duration.minutes(10);
const CATALOG_PREVIEW_ENTRIES = 6;
const MAX_CACHED_PAGES = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ATTEMPT_TIMEOUT = Duration.seconds(10);
const RETRIES = 2;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

export const UNSUPPORTED_LOCAL_ONLY = "Runs locally. Local servers are not supported yet";
export const UNSUPPORTED_REQUIRES_CONFIGURATION =
  "Requires configuration (headers or URL settings) before it can be connected";
export const UNSUPPORTED_NOT_HTTPS = "Its remote endpoint is not served over https";
export const UNSUPPORTED_TRANSPORT =
  "Uses a transport other than Streamable HTTP, which is not supported";
const UNSUPPORTED_NO_ENDPOINT = "Publishes no remote endpoint";

const RegistryInput = Schema.Struct({
  isRequired: Schema.optional(Schema.Boolean),
  /** A fixed value the client must send as is. */
  value: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
});

const RegistryRemote = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  headers: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: Schema.String, isRequired: Schema.optional(Schema.Boolean) }),
    ),
  ),
  variables: Schema.optional(Schema.Record(Schema.String, RegistryInput)),
});
type RegistryRemote = typeof RegistryRemote.Type;

const RegistryServerEntry = Schema.Struct({
  server: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    websiteUrl: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.String) })),
    remotes: Schema.optional(Schema.Array(RegistryRemote)),
    packages: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  _meta: Schema.optional(
    Schema.Struct({
      [OFFICIAL_META_KEY]: Schema.optional(
        Schema.Struct({
          status: Schema.optional(Schema.String),
          publishedAt: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
type RegistryServerEntry = typeof RegistryServerEntry.Type;

/** The page envelope; entries are decoded one by one so one malformed server cannot hide a page. */
const RegistryResponse = Schema.fromJsonString(
  Schema.Struct({
    servers: Schema.Array(Schema.Unknown),
    metadata: Schema.optional(Schema.Struct({ nextCursor: Schema.optional(Schema.String) })),
  }),
);
const decodeRegistryResponse = Schema.decodeUnknownExit(RegistryResponse);
const decodeRegistryServerEntry = Schema.decodeUnknownExit(RegistryServerEntry);

class RegistryAttemptError extends Schema.TaggedError<RegistryAttemptError>()(
  "RegistryAttemptError",
  { retryable: Schema.Boolean, message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

const decodeRegistryServerJson = Schema.decodeUnknownExit(
  Schema.fromJsonString(RegistryServerEntry),
);

/** One server read by exact name: an empty page when it is not active. */
const parseRegistryServer = (body: string) => {
  const decoded = decodeRegistryServerJson(body);
  if (Exit.isFailure(decoded)) return undefined;
  const active =
    decoded.value._meta?.[OFFICIAL_META_KEY]?.status === "active" &&
    decoded.value.server.name.trim() !== "" &&
    decoded.value.server.version.trim() !== "";
  return { entries: active ? [toDiscoverEntry(decoded.value)] : [], nextCursor: undefined };
};

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Substitute fixed values, then defaults, and only then classify the URL.
 * `undefined` means the remote cannot be a connector endpoint (not https, or
 * credentials in the URL); an unresolved template stays listed but needs input.
 */
function resolveRemote(remote: RegistryRemote): DiscoverRemote | undefined {
  let url = remote.url.trim();
  for (const [name, variable] of Object.entries(remote.variables ?? {})) {
    const substitute = nonBlank(variable.value) ?? nonBlank(variable.default);
    if (substitute !== undefined) url = url.replaceAll(`{${name}}`, substitute);
  }
  const placeholder = url.search(/\{[^}]*\}/u);
  if (placeholder !== -1) {
    // The scheme is known only if it precedes the first unresolved variable.
    const literalPrefix = url.slice(0, placeholder).toLowerCase();
    if (literalPrefix.includes("://") && !literalPrefix.startsWith("https://")) return undefined;
    return { type: remote.type, url, requiresInput: true };
  }
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  return {
    type: remote.type,
    url,
    requiresInput: (remote.headers ?? []).some((header) => header.isRequired === true),
  };
}

/** Normalize one active registry server into a Discover entry. */
function toDiscoverEntry(entry: RegistryServerEntry): Omit<DiscoverEntry, "installedConnectorId"> {
  const { server } = entry;
  const remotes = server.remotes ?? [];
  const streamable = remotes.filter((remote) => remote.type === "streamable-http");
  const usable = streamable.flatMap((remote) => resolveRemote(remote) ?? []);
  const installable = usable.some((remote) => !remote.requiresInput);
  const unsupportedReason = installable
    ? undefined
    : usable.length > 0
      ? UNSUPPORTED_REQUIRES_CONFIGURATION
      : streamable.length > 0
        ? UNSUPPORTED_NOT_HTTPS
        : remotes.length > 0
          ? UNSUPPORTED_TRANSPORT
          : (server.packages ?? []).length > 0
            ? UNSUPPORTED_LOCAL_ONLY
            : UNSUPPORTED_NO_ENDPOINT;
  const title = nonBlank(server.title);
  const description = nonBlank(server.description);
  const websiteUrl = nonBlank(server.websiteUrl);
  const repositoryUrl = nonBlank(server.repository?.url);
  const publishedAt = nonBlank(entry._meta?.[OFFICIAL_META_KEY]?.publishedAt);
  return {
    name: server.name.trim(),
    version: server.version.trim(),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(websiteUrl === undefined ? {} : { websiteUrl }),
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    remotes: usable,
    categories: [],
    installable,
    ...(unsupportedReason === undefined ? {} : { unsupportedReason }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

/** Decode a registry page: active, well-formed servers only, in registry order. */
export function parseRegistryPage(body: string):
  | {
      readonly entries: ReadonlyArray<Omit<DiscoverEntry, "installedConnectorId">>;
      readonly nextCursor: string | undefined;
    }
  | undefined {
  const decoded = decodeRegistryResponse(body);
  if (Exit.isFailure(decoded)) return undefined;
  const entries: Array<Omit<DiscoverEntry, "installedConnectorId">> = [];
  for (const raw of decoded.value.servers) {
    const server = decodeRegistryServerEntry(raw);
    if (Exit.isFailure(server)) continue;
    if (server.value._meta?.[OFFICIAL_META_KEY]?.status !== "active") continue;
    if (server.value.server.name.trim() === "" || server.value.server.version.trim() === "") {
      continue;
    }
    entries.push(toDiscoverEntry(server.value));
  }
  return { entries, nextCursor: nonBlank(decoded.value.metadata?.nextCursor) };
}

interface CachedPage {
  readonly expiresAtMs: number;
  readonly entries: ReadonlyArray<Omit<DiscoverEntry, "installedConnectorId">>;
  readonly nextCursor: string | undefined;
  readonly fetchedAt: string;
}

export interface DiscoverOptions {
  /** Curated servers; the shipped catalog by default. */
  readonly servers?: ReadonlyArray<CuratedServer>;
}

/** How a curated entry is matched against connectors and registry results. */
const curatedKeys = (server: CuratedServer) => ({
  name: server.registry?.name,
  url: canonicalConnectorUrl(server.url),
});

const matchesQuery = (server: CuratedServer, terms: ReadonlyArray<string>): boolean => {
  const haystack = `${server.displayName}\n${server.tagline}\n${server.description}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

/** Entries whose primary category is `category` first, then the rest, each in catalog order. */
const serversIn = (servers: ReadonlyArray<CuratedServer>, category: ExtensionCategory) => {
  const members = servers.filter((server) => server.categories.includes(category));
  if (category === "featured") return members;
  const primary = (server: CuratedServer) =>
    server.categories.find((candidate) => candidate !== "featured") === category;
  return [...members.filter(primary), ...members.filter((server) => !primary(server))];
};

export const makeWith = Effect.fn("ExtensionsDiscover.make")(function* (
  options: DiscoverOptions = {},
) {
  const httpClient = yield* HttpClient.HttpClient;
  const connectorRuntime = yield* Effect.serviceOption(ConnectorRuntime);
  const servers = options.servers ?? CURATED_SERVERS;
  // Keyed by query, cursor and limit; Map insertion order drives eviction.
  const cache = new Map<string, CachedPage>();

  const fetchOnce = Effect.fn("ExtensionsDiscover.fetchOnce")(
    function* (url: string) {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
      );
      if (response.status !== 200) {
        return yield* new RegistryAttemptError({
          retryable: response.status === 429 || response.status >= 500,
          message: `The MCP Registry answered with HTTP ${response.status}.`,
          status: response.status,
        });
      }
      const declaredLength = Number(response.headers["content-length"] ?? "0");
      const tooLarge = new RegistryAttemptError({
        retryable: false,
        message: "The MCP Registry response exceeds 4 MiB.",
      });
      if (declaredLength > MAX_RESPONSE_BYTES) return yield* tooLarge;
      // Count streamed bytes too: the length header is optional and untrusted.
      const chunks = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => ({ size: 0, parts: [] as Uint8Array[] }),
          (accumulated, chunk: Uint8Array) => {
            const size = accumulated.size + chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES) return Effect.fail(tooLarge);
            accumulated.parts.push(chunk);
            return Effect.succeed({ size, parts: accumulated.parts });
          },
        ),
      );
      return Buffer.concat(chunks.parts, chunks.size).toString("utf8");
    },
    (effect) =>
      effect.pipe(
        // One deadline covers headers and body; interruption aborts the request.
        Effect.timeoutOrElse({
          duration: ATTEMPT_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new RegistryAttemptError({
                retryable: true,
                message: "The MCP Registry did not answer in time.",
              }),
            ),
        }),
        Effect.mapError((error) => {
          if (error._tag === "RegistryAttemptError") return error;
          const transport =
            HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError";
          return new RegistryAttemptError({
            retryable: transport,
            message: transport
              ? "Scient could not reach the MCP Registry."
              : "The MCP Registry response could not be read.",
          });
        }),
      ),
  );

  /** Live installation state: connectors by registry name and by canonical URL. */
  const installedConnectors = Effect.gen(function* () {
    const byName = new Map<string, ConnectorId>();
    const byUrl = new Map<string, ConnectorId>();
    if (Option.isNone(connectorRuntime)) return { byName, byUrl };
    const inventory = yield* connectorRuntime.value.list();
    for (const connector of inventory.connectors) {
      if (connector.source.type === "registry" && !byName.has(connector.source.name)) {
        byName.set(connector.source.name, connector.connectorId);
      }
      const url = canonicalConnectorUrl(connector.url);
      if (!byUrl.has(url)) byUrl.set(url, connector.connectorId);
    }
    return { byName, byUrl };
  });

  type Installed = Effect.Success<typeof installedConnectors>;

  const installedFor = (
    installed: Installed,
    name: string,
    urls: ReadonlyArray<string>,
  ): ConnectorId | undefined =>
    installed.byName.get(name) ??
    urls
      .map((url) => installed.byUrl.get(canonicalConnectorUrl(url)))
      .find((id) => id !== undefined);

  /** A curated entry with its bundled icon and live installation state. */
  const curatedEntry = (server: CuratedServer, installed: Installed): DiscoverEntry => {
    const entry = curatedDiscoverEntry(server);
    const installedConnectorId = installedFor(installed, entry.name, [server.url]);
    return installedConnectorId === undefined ? entry : { ...entry, installedConnectorId };
  };

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
  );

  const catalog: ExtensionsDiscoverShape["catalog"] = Effect.fn("ExtensionsDiscover.catalog")(
    function* () {
      const installed = yield* installedConnectors;
      const previews = CATALOG_CATEGORY_ORDER.flatMap((category) => {
        const members = serversIn(servers, category);
        return members.length === 0
          ? []
          : [{ category, members, preview: members.slice(0, CATALOG_PREVIEW_ENTRIES) }];
      });
      const sections = previews.map(({ category, members, preview }): DiscoverCatalogSection => ({
        category,
        title: CATALOG_SECTIONS[category].title,
        description: CATALOG_SECTIONS[category].description,
        entries: preview.map((server) => curatedEntry(server, installed)),
        total: members.length,
      }));
      return { sections, fetchedAt: yield* nowIso } satisfies DiscoverCatalog;
    },
  );

  /** The curated server a registry entry publishes, by registry name or remote URL. */
  const curatedFor = (entry: Omit<DiscoverEntry, "installedConnectorId">) =>
    servers.find((server) => {
      const keys = curatedKeys(server);
      return (
        keys.name === entry.name ||
        entry.remotes.some((remote) => canonicalConnectorUrl(remote.url) === keys.url)
      );
    });

  /**
   * One registry read through the page cache; `undefined` from `parse` means a
   * bad response. A 404 is `not-found` only when `byName` (an exact-name read).
   */
  const readRegistry = Effect.fn("ExtensionsDiscover.readRegistry")(function* (
    key: string,
    parse: (body: string) => Omit<CachedPage, "expiresAtMs" | "fetchedAt"> | undefined,
    byName: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cachedPage = cache.get(key);
    if (cachedPage !== undefined && cachedPage.expiresAtMs > now) return cachedPage;
    const body = yield* fetchOnce(key).pipe(
      Effect.retry({
        times: RETRIES,
        while: (error) => error.retryable,
        schedule: Schedule.exponential(Duration.millis(250)),
      }),
      Effect.mapError((error) =>
        byName && error.status === 404
          ? new ExtensionsError({
              reason: "not-found",
              message: "The MCP Registry has no such server.",
            })
          : new ExtensionsError({ reason: "unreachable", message: error.message }),
      ),
    );
    const parsed = parse(body);
    if (parsed === undefined) {
      return yield* new ExtensionsError({
        reason: "unreachable",
        message: "The MCP Registry returned an unexpected response.",
      });
    }
    const page: CachedPage = {
      ...parsed,
      expiresAtMs: now + Duration.toMillis(DISCOVER_CACHE_TTL),
      fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    };
    cache.delete(key);
    cache.set(key, page);
    for (const staleKey of cache.keys()) {
      if (cache.size <= MAX_CACHED_PAGES) break;
      cache.delete(staleKey);
    }
    return page;
  });

  /**
   * A registry result as clients see it. A curated server's alias (same
   * registry name or canonical remote URL) is the curated entry itself, exactly
   * as the curated scope returns it, so both scopes share its `name`.
   */
  const registryEntry = (
    entry: Omit<DiscoverEntry, "installedConnectorId">,
    installed: Installed,
  ): DiscoverEntry => {
    const curated = curatedFor(entry);
    if (curated !== undefined) return curatedEntry(curated, installed);
    const installedConnectorId = installedFor(
      installed,
      entry.name,
      entry.remotes.map((remote) => remote.url),
    );
    return installedConnectorId === undefined ? entry : { ...entry, installedConnectorId };
  };

  /** Registry results with curated aliases folded in, each curated server once. */
  const registryEntries = (
    entries: ReadonlyArray<Omit<DiscoverEntry, "installedConnectorId">>,
    installed: Installed,
  ): ReadonlyArray<DiscoverEntry> => {
    const seen = new Set<string>();
    return entries.flatMap((entry) => {
      const shown = registryEntry(entry, installed);
      if (seen.has(shown.name)) return [];
      seen.add(shown.name);
      return [shown];
    });
  };

  const search: ExtensionsDiscoverShape["search"] = Effect.fn("ExtensionsDiscover.search")(
    function* (input) {
      const query = (input.query ?? "").trim().slice(0, MAX_QUERY_LENGTH);
      const terms = query
        .toLowerCase()
        .split(/\s+/u)
        .filter((term) => term !== "");
      if (input.scope === "curated") {
        // Small and complete: filtered in memory, never paged.
        const curatedMatches = (
          input.category === undefined ? servers : serversIn(servers, input.category)
        ).filter((server) => matchesQuery(server, terms));
        const installed = yield* installedConnectors;
        return {
          entries: curatedMatches.map((server) => curatedEntry(server, installed)),
          fetchedAt: yield* nowIso,
        } satisfies DiscoverPage;
      }

      if (input.category !== undefined) {
        return yield* new ExtensionsError({
          reason: "invalid-input",
          message: "Categories are Scient's curated catalog; search them with scope 'curated'.",
        });
      }
      const cursor = input.cursor?.trim();
      const requestedLimit =
        input.limit !== undefined && Number.isFinite(input.limit)
          ? Math.trunc(input.limit)
          : DEFAULT_LIMIT;
      const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit));
      const url = new URL(MCP_REGISTRY_SERVERS_URL);
      if (query !== "") url.searchParams.set("search", query);
      url.searchParams.set("limit", String(limit));
      if (cursor !== undefined && cursor !== "") url.searchParams.set("cursor", cursor);
      url.searchParams.set("version", "latest");
      const page = yield* readRegistry(url.href, parseRegistryPage, false);
      // Installation state is live, never cached with the registry page.
      const installed = yield* installedConnectors;
      return {
        entries: registryEntries(page.entries, installed),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        fetchedAt: page.fetchedAt,
      } satisfies DiscoverPage;
    },
  );

  const entry: ExtensionsDiscoverShape["entry"] = Effect.fn("ExtensionsDiscover.entry")(
    function* (input) {
      // The complete curated catalog first, not only the home-page previews.
      const curated = servers.find((server) => curatedDiscoverEntry(server).name === input.name);
      if (curated !== undefined) {
        return curatedEntry(curated, yield* installedConnectors);
      }
      if (input.name.startsWith(CURATED_NAME_PREFIX)) {
        return yield* new ExtensionsError({
          reason: "not-found",
          message: `No curated server is named '${input.name}'.`,
        });
      }
      const page = yield* readRegistry(
        `${MCP_REGISTRY_SERVERS_URL}/${encodeURIComponent(input.name)}/versions/latest`,
        parseRegistryServer,
        true,
      );
      const matches = page.entries.filter((candidate) => candidate.name === input.name);
      const found = registryEntries(matches, yield* installedConnectors)[0];
      if (found === undefined) {
        return yield* new ExtensionsError({
          reason: "not-found",
          message: `The MCP Registry has no active server named '${input.name}'.`,
        });
      }
      return found;
    },
  );

  const connectorIcons: ExtensionsDiscoverShape["connectorIcons"] = (urls) =>
    Effect.sync(
      () =>
        new Map(
          urls.flatMap((url) => {
            const curated = curatedServerForUrl(url, servers);
            return curated === undefined ? [] : [[url, curated.icon] as const];
          }),
        ),
    );

  return ExtensionsDiscover.of({ search, catalog, entry, connectorIcons });
});

export const layer = Layer.effect(ExtensionsDiscover, makeWith());
