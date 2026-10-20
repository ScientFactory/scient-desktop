/**
 * Discover: a server-side client for the official MCP Registry. Entries are
 * filtered to active servers and normalized into `DiscoverEntry`, where only a
 * Streamable HTTP remote over https that needs no user-supplied headers or URL
 * variables is one-click installable as a connector.
 * See docs/internals/scient-extensions.md.
 */
import {
  ExtensionsError,
  type ConnectorId,
  type DiscoverEntry,
  type DiscoverPage,
  type DiscoverRemote,
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

export const MCP_REGISTRY_SERVERS_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";
export const DISCOVER_CACHE_TTL = Duration.minutes(10);
const MAX_CACHED_PAGES = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ATTEMPT_TIMEOUT = Duration.seconds(10);
const RETRIES = 2;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 200;

export const UNSUPPORTED_LOCAL_ONLY = "Runs locally — local servers are not supported yet";
export const UNSUPPORTED_REQUIRES_CONFIGURATION =
  "Requires configuration (headers or URL settings) before it can be connected";
export const UNSUPPORTED_NOT_HTTPS = "Its remote endpoint is not served over https";
export const UNSUPPORTED_TRANSPORT =
  "Uses a transport other than Streamable HTTP, which is not supported";
export const UNSUPPORTED_NO_ENDPOINT = "Publishes no remote endpoint";

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
  { retryable: Schema.Boolean, message: Schema.String },
) {}

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
export function toDiscoverEntry(
  entry: RegistryServerEntry,
): Omit<DiscoverEntry, "installedConnectorId"> {
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

const make = Effect.fn("ExtensionsDiscover.make")(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const connectorRuntime = yield* Effect.serviceOption(ConnectorRuntime);
  // Keyed by query, cursor and limit; Map insertion order drives eviction.
  const cache = new Map<string, CachedPage>();

  const fetchOnce = (url: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
      );
      if (response.status !== 200) {
        return yield* new RegistryAttemptError({
          retryable: response.status === 429 || response.status >= 500,
          message: `The MCP Registry answered with HTTP ${response.status}.`,
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
    }).pipe(
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
    );

  const installedByRegistryName = Effect.gen(function* () {
    if (Option.isNone(connectorRuntime)) return new Map<string, ConnectorId>();
    const inventory = yield* connectorRuntime.value.list({ projectId: undefined });
    const byName = new Map<string, ConnectorId>();
    for (const connector of inventory.connectors) {
      if (connector.source.type === "registry" && !byName.has(connector.source.name)) {
        byName.set(connector.source.name, connector.connectorId);
      }
    }
    return byName;
  });

  const search: ExtensionsDiscoverShape["search"] = Effect.fn("ExtensionsDiscover.search")(
    function* (input) {
      const query = (input.query ?? "").trim().slice(0, MAX_QUERY_LENGTH);
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
      const key = url.href;

      const now = yield* Clock.currentTimeMillis;
      let page = cache.get(key);
      if (page === undefined || page.expiresAtMs <= now) {
        const body = yield* fetchOnce(key).pipe(
          Effect.retry({
            times: RETRIES,
            while: (error) => error.retryable,
            schedule: Schedule.exponential(Duration.millis(250)),
          }),
          Effect.mapError(
            (error) => new ExtensionsError({ reason: "unreachable", message: error.message }),
          ),
        );
        const parsed = parseRegistryPage(body);
        if (parsed === undefined) {
          return yield* new ExtensionsError({
            reason: "unreachable",
            message: "The MCP Registry returned an unexpected response.",
          });
        }
        page = {
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
      }

      // Installation state is live, never cached with the registry page.
      const installed = yield* installedByRegistryName;
      return {
        entries: page.entries.map((entry) => {
          const installedConnectorId = installed.get(entry.name);
          return installedConnectorId === undefined ? entry : { ...entry, installedConnectorId };
        }),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        fetchedAt: page.fetchedAt,
      } satisfies DiscoverPage;
    },
  );

  return ExtensionsDiscover.of({ search });
});

export const layer = Layer.effect(ExtensionsDiscover, make());
