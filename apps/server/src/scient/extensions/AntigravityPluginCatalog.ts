/**
 * Google's two public Antigravity plugin catalogs, read the way the agy CLI reads them: fixed
 * gstatic addresses, no sign-in. Each catalog is fetched, bounded and decoded on its own, so one
 * outage leaves the other listed.
 */
import {
  storeCategories,
  type ExtensionCategory,
  type ExtensionIconDataUri,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { extensionIconData } from "./ExtensionIconData.ts";

export const ANTIGRAVITY_MARKETPLACES = [
  {
    name: "antigravity-plugins-official",
    url: "https://www.gstatic.com/antigravity/plugins/marketplace.json",
    publisherType: "google",
  },
  {
    name: "antigravity-plugins-partners",
    url: "https://www.gstatic.com/antigravity/plugins-partners/marketplace.json",
    publisherType: "third-party",
  },
] as const;
export type AntigravityMarketplace = (typeof ANTIGRAVITY_MARKETPLACES)[number];
export type AntigravityMarketplaceName = AntigravityMarketplace["name"];

const GSTATIC_HOST = "www.gstatic.com";
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_FEED_PLUGINS = 2_000;
const MAX_ICON_BYTES = 64 * 1024;

export const AntigravityPluginName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/),
);
const Feed = Schema.Struct({
  name: Schema.String,
  plugins: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_FEED_PLUGINS)),
});
// Only the identity and the download are required; display fields are read leniently.
const FeedPlugin = Schema.Struct({
  name: AntigravityPluginName,
  displayName: Schema.optional(Schema.Unknown),
  version: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
  logo: Schema.optional(Schema.Unknown),
  author: Schema.optional(Schema.Unknown),
  homepage: Schema.optional(Schema.Unknown),
  category: Schema.optional(Schema.Unknown),
  keywords: Schema.optional(Schema.Unknown),
  skills: Schema.optional(Schema.Unknown),
  mcpServers: Schema.optional(Schema.Unknown),
  source: Schema.Struct({
    type: Schema.String,
    url: Schema.optional(Schema.String),
    sha256: Schema.optional(Schema.String),
  }),
});
const decodeFeed = Schema.decodeUnknownEffect(Schema.fromJsonString(Feed));
const decodeFeedPlugin = Schema.decodeUnknownOption(FeedPlugin);

export interface AntigravityCatalogPlugin {
  readonly name: string;
  readonly marketplace: AntigravityMarketplaceName;
  readonly publisherType: AntigravityMarketplace["publisherType"];
  readonly displayName: string;
  readonly description: string;
  readonly version?: string | undefined;
  readonly publisher?: string | undefined;
  readonly website?: string | undefined;
  readonly categories: ReadonlyArray<string>;
  /** Scient's Discover categories, from the reviewed map or the catalog's own labels. */
  readonly scientCategories: ReadonlyArray<ExtensionCategory>;
  readonly logoUrl?: string | undefined;
  readonly keywords: ReadonlyArray<string>;
  readonly includes: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
  /** Absent when the catalog's download is not a checksummed gstatic archive. */
  readonly archive?: { readonly url: string; readonly sha256: string } | undefined;
}

export interface AntigravityCatalogRead {
  readonly plugins: ReadonlyArray<AntigravityCatalogPlugin>;
  readonly sourceFailures: ReadonlyArray<AntigravityMarketplaceName>;
}

export class AntigravityCatalogError extends Schema.TaggedError<AntigravityCatalogError>()(
  "AntigravityCatalogError",
  { marketplace: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read ${this.marketplace}: ${this.detail}`;
  }
}

/** `https://www.gstatic.com/…` with nothing that could point elsewhere. */
function isGstaticUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === GSTATIC_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

/** Where both catalogs keep their plugin archives. */
export function isAntigravityGstaticUrl(value: string): boolean {
  return isGstaticUrl(value) && new URL(value).pathname.startsWith("/antigravity/");
}

const nonBlank = (value: unknown) => {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
};

const strings = (value: unknown): ReadonlyArray<string> =>
  (Array.isArray(value) ? value : [value]).flatMap((item) => {
    const text = nonBlank(item);
    return text ? [text] : [];
  });

const httpsUrl = (value: unknown) => {
  const trimmed = nonBlank(value);
  return trimmed && URL.canParse(trimmed) && new URL(trimmed).protocol === "https:"
    ? trimmed
    : undefined;
};

/** Names a component list gives, whether as paths (`./skills/x`), objects or a record's keys. */
function componentNames(value: unknown): ReadonlyArray<string> {
  const names = Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "string"
          ? [item.split(/[\\/]/).filter(Boolean).at(-1) ?? ""]
          : typeof item === "object" && item !== null && "name" in item
            ? [String(item.name)]
            : [],
      )
    : typeof value === "object" && value !== null
      ? Object.keys(value)
      : [];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 200);
}

/** Reviewed Discover categories per catalog plugin (2026-11-21 catalogs); others fall back. */
const ANTIGRAVITY_CATEGORIES: Readonly<Record<string, ReadonlyArray<ExtensionCategory>>> = {
  // Google: Workspace, science, developer.
  gmail: ["communication"],
  gcalendar: ["communication", "projects"],
  gdocs: ["files"],
  gdrive: ["files"],
  gsheets: ["files", "data"],
  gslides: ["files", "figures"],
  "scientific-literature": ["papers"],
  "science-overview": ["papers", "biology", "chemistry"],
  chemistry: ["chemistry"],
  genomics: ["biology"],
  "structural-biology": ["biology", "chemistry"],
  robotics: ["physics-math", "code"],
  "data-agent-kit-plugin": ["data", "code"],
  looker: ["data"],
  google_maps_platform: ["earth", "code"],
  egm: ["files"],
  "android-cli-plugin": ["code"],
  "chrome-devtools-plugin": ["code"],
  firebase: ["code"],
  flutter: ["code"],
  "gemini-api": ["code"],
  "google-antigravity-sdk": ["code"],
  "google-cloud-developer": ["code"],
  "google-developer-knowledge": ["code"],
  "google-health-developer": ["code"],
  "google-home-developer": ["code"],
  "modern-web-guidance-plugin": ["code"],
  // Partners.
  canva: ["figures"],
  figma: ["figures"],
  mobbin: ["figures"],
  invideo: ["figures"],
  notion: ["files", "projects"],
  dropbox: ["files"],
  docusign: ["files"],
  pandadoc: ["files"],
  linear: ["projects", "code"],
  monday: ["projects"],
  clickup: ["projects"],
  trello: ["projects"],
  "atlassian-twg-cli": ["projects", "files"],
  "zoho-projects": ["projects"],
  "zoho-bigin": ["projects"],
  zapier: ["projects"],
  "n8n-skills": ["projects", "code"],
  granola: ["communication"],
  "wispr-flow": ["communication"],
  intercom: ["communication"],
  "zoho-desk-antigravity": ["communication"],
  keenable: ["papers"],
  "keenable-select": ["papers", "data"],
  parallel: ["papers"],
  tavily: ["papers"],
  midpage: ["papers", "social-science"],
  "levels-fyi": ["social-science"],
  semrush: ["data"],
  databricks: ["data", "code"],
  "mongodb-atlas": ["data", "code"],
  neo4j: ["data", "code"],
  supabase: ["data", "code"],
  "arize-skills": ["data", "code"],
  "grafana-cloud-mcp": ["data", "code"],
  "zohobooks-antigravity": ["data"],
  // Developer, security and operations tooling.
  stripe: ["code"],
  auth0: ["code"],
  base44: ["code"],
  betterstack: ["code"],
  browse: ["code"],
  clerk: ["code"],
  cloudflare: ["code"],
  coderabbit: ["code"],
  context7: ["code"],
  crowdstrike: ["code"],
  datadog: ["code"],
  dynatrace: ["code"],
  "endor-labs-agent-kit": ["code"],
  "harness-antigravity": ["code"],
  "incident-io": ["code"],
  "leapwork-play": ["code"],
  netlify: ["code"],
  "ping-identity-pingone": ["code"],
  postman: ["code"],
  qodo: ["code"],
  railway: ["code"],
  "scandit-sdk": ["code"],
  "sentinelone-purple-mcp": ["code"],
  sentry: ["code"],
  soc: ["code"],
  sonarqube: ["code"],
  spacefast: ["code"],
  superpowers: ["code"],
  "testmu-ai": ["code"],
  unity: ["code"],
  "vercel-plugin": ["code"],
  virustotal: ["code"],
  wix: ["code"],
  wordpress: ["code"],
  "zoho-crm-plugin": ["code"],
};
/**
 * Discover categories for a catalog plugin: the reviewed list, else the catalog's own categories,
 * else its keywords. Most used stays Scient's picks.
 */
export function antigravityCategories(
  name: string,
  categories: ReadonlyArray<string>,
  keywords: ReadonlyArray<string>,
): ReadonlyArray<ExtensionCategory> {
  const reviewed = ANTIGRAVITY_CATEGORIES[name];
  if (reviewed) return reviewed;
  for (const labels of [categories, keywords]) {
    const found = [
      ...new Set(labels.flatMap((label) => storeCategories("", label.replace(/-/g, " ")))),
    ].filter((category) => category !== "most-used");
    if (found.length) return found;
  }
  return [];
}

function catalogPlugin(
  marketplace: AntigravityMarketplace,
  raw: unknown,
): AntigravityCatalogPlugin | undefined {
  const decoded = decodeFeedPlugin(raw);
  if (decoded._tag === "None") return undefined;
  const plugin = decoded.value;
  const skills = componentNames(plugin.skills);
  const mcpServers = componentNames(plugin.mcpServers);
  const sha256 = plugin.source.sha256?.toLowerCase();
  const archive =
    plugin.source.type === "archive" &&
    plugin.source.url !== undefined &&
    isAntigravityGstaticUrl(plugin.source.url) &&
    sha256 !== undefined &&
    /^[0-9a-f]{64}$/.test(sha256)
      ? { url: plugin.source.url, sha256 }
      : undefined;
  const author =
    typeof plugin.author === "object" && plugin.author !== null && "name" in plugin.author
      ? nonBlank(plugin.author.name)
      : nonBlank(plugin.author);
  const publisher = author ?? (marketplace.publisherType === "google" ? "Google" : undefined);
  const categories = strings(plugin.category).slice(0, 10);
  const keywords = (Array.isArray(plugin.keywords) ? strings(plugin.keywords) : []).slice(0, 50);
  return {
    name: plugin.name,
    marketplace: marketplace.name,
    publisherType: marketplace.publisherType,
    displayName: nonBlank(plugin.displayName) ?? plugin.name,
    description: nonBlank(plugin.description) ?? "",
    version: nonBlank(plugin.version),
    publisher,
    website: httpsUrl(plugin.homepage),
    categories,
    scientCategories: antigravityCategories(plugin.name, categories, keywords),
    logoUrl: httpsUrl(plugin.logo),
    keywords,
    includes: [...(skills.length ? ["Skills"] : []), ...(mcpServers.length ? ["MCP servers"] : [])],
    skills,
    mcpServers,
    archive,
  };
}

/** Reads at most `limit` bytes of a body; a longer body fails rather than truncating. */
const readBoundedBody = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.length > limit) return Effect.fail("too-large" as const);
        state.chunks.push(chunk);
        state.bytes += chunk.length;
        return Effect.succeed(state);
      },
    ),
    Effect.map((state) => Buffer.concat(state.chunks)),
  );

/** One GET of a fixed gstatic address: no redirects followed, no credentials sent. */
export const getGstatic = (http: HttpClient.HttpClient, url: string, accept: string) =>
  http
    .execute(HttpClientRequest.get(url, { headers: { accept } }))
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));

const readFeed = Effect.fn("AntigravityPluginCatalog.readFeed")(
  function* (http: HttpClient.HttpClient, marketplace: AntigravityMarketplace) {
    const failed = (detail: string) => (cause?: unknown) =>
      new AntigravityCatalogError({ marketplace: marketplace.name, detail, cause });
    const response = yield* getGstatic(http, marketplace.url, "application/json").pipe(
      Effect.mapError(failed("the catalog could not be reached")),
    );
    if (response.status !== 200)
      return yield* failed(`the catalog answered with HTTP ${response.status}`)();
    const body = yield* readBoundedBody(response.stream, MAX_FEED_BYTES).pipe(
      Effect.mapError(failed("the catalog was too large or could not be read")),
    );
    const feed = yield* decodeFeed(body.toString("utf8")).pipe(
      Effect.mapError(failed("the catalog is not in the expected format")),
    );
    if (feed.name !== marketplace.name)
      return yield* failed("the catalog names a different marketplace")();
    const seen = new Set<string>();
    const plugins: AntigravityCatalogPlugin[] = [];
    for (const raw of feed.plugins) {
      const plugin = catalogPlugin(marketplace, raw);
      if (!plugin || seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      plugins.push(plugin);
    }
    return plugins;
  },
  (effect, _http, marketplace) =>
    Effect.timeoutOrElse(effect, {
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new AntigravityCatalogError({
            marketplace: marketplace.name,
            detail: "the catalog took too long to answer",
          }),
        ),
    }),
);

/**
 * Both catalogs, cached for ten minutes per catalog (a failure for fifteen seconds). Concurrent
 * readers share one fetch; `refresh` fetches both again.
 */
export const makeAntigravityPluginCatalog = Effect.fn("makeAntigravityPluginCatalog")(function* (
  marketplaces: ReadonlyArray<AntigravityMarketplace> = ANTIGRAVITY_MARKETPLACES,
) {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.makeWith(
    (name: AntigravityMarketplaceName) => {
      const marketplace = marketplaces.find((item) => item.name === name)!;
      return readFeed(http, marketplace);
    },
    {
      capacity: marketplaces.length,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "10 minutes" : "15 seconds"),
    },
  );
  const icons = new Map<string, ExtensionIconDataUri | undefined>();
  const readIcon = Effect.fn("AntigravityPluginCatalog.icon")(function* (url: string | undefined) {
    if (!url || !isGstaticUrl(url)) return undefined;
    if (icons.has(url)) return icons.get(url);
    const icon = yield* Effect.gen(function* () {
      const response = yield* getGstatic(
        http,
        url,
        "image/svg+xml,image/png,image/webp,image/jpeg",
      );
      if (response.status !== 200) return undefined;
      return extensionIconData(yield* readBoundedBody(response.stream, MAX_ICON_BYTES));
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => undefined),
    );
    icons.set(url, icon);
    while (icons.size > 512) icons.delete(icons.keys().next().value!);
    return icon;
  });
  const read = Effect.fn("AntigravityPluginCatalog.read")(function* (refresh = false) {
    const results = yield* Effect.forEach(
      marketplaces,
      (marketplace) =>
        (refresh
          ? Cache.refresh(cache, marketplace.name)
          : Cache.get(cache, marketplace.name)
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning(cause.message)),
          Effect.result,
        ),
      { concurrency: "unbounded" },
    );
    const plugins: AntigravityCatalogPlugin[] = [];
    const sourceFailures: AntigravityMarketplaceName[] = [];
    const seen = new Set<string>();
    for (const [index, result] of results.entries()) {
      if (result._tag === "Failure") {
        sourceFailures.push(marketplaces[index]!.name);
        continue;
      }
      // A slug both catalogs list installs to one folder; the first catalog keeps it.
      for (const plugin of result.success) {
        if (seen.has(plugin.name)) continue;
        seen.add(plugin.name);
        plugins.push(plugin);
      }
    }
    return { plugins, sourceFailures } satisfies AntigravityCatalogRead;
  });
  return {
    read,
    invalidate: Cache.invalidateAll(cache),
    icon: readIcon,
  };
});
export type AntigravityPluginCatalog = Effect.Success<
  ReturnType<typeof makeAntigravityPluginCatalog>
>;
