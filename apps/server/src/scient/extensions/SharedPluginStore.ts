import type {
  ProviderStoreEntry,
  ProviderStorePage,
  ProviderStoreSearchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import { readLocalPluginContents, readLocalPluginSkill } from "./LocalPluginContents.ts";
import { readPluginJson } from "./LocalPluginFiles.ts";

const Name = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,62}[a-zA-Z0-9])?$/),
);
const Known = Schema.Record(
  Name,
  Schema.Struct({
    installLocation: Schema.String,
    source: Schema.optional(
      Schema.Struct({
        source: Schema.String,
        repo: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const AgentMarkets = Schema.Struct({
  version: Schema.Literal(1),
  marketplaces: Schema.Array(
    Schema.Struct({ name: Name, catalogPath: Schema.String, sourceUri: Schema.String }),
  ),
});
const Catalog = Schema.Struct({
  name: Name,
  metadata: Schema.optional(Schema.Struct({ pluginRoot: Schema.optional(Schema.String) })),
  plugins: Schema.Array(Schema.Unknown),
});
const Plugin = Schema.Struct({
  name: Name,
  source: Schema.Union([
    Schema.String,
    Schema.Struct({
      source: Schema.String,
      repo: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ]),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Struct({ name: Schema.String })),
});
const Reviews = Schema.Struct({
  listings: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.optional(
        Schema.Struct({
          repository: Schema.optional(
            Schema.Struct({ url: Schema.String, path: Schema.optional(Schema.String) }),
          ),
        }),
      ),
      checks: Schema.optional(
        Schema.Struct({
          review: Schema.optional(
            Schema.Struct({
              state: Schema.String,
              by: Schema.optional(Schema.Struct({ type: Schema.String })),
            }),
          ),
        }),
      ),
    }),
  ),
});
const decodeKnown = Schema.decodeUnknownEffect(Known);
const decodeMarkets = Schema.decodeUnknownEffect(AgentMarkets);
const decodeCatalog = Schema.decodeUnknownEffect(Catalog);
const decodePlugin = Schema.decodeUnknownOption(Plugin);
const decodeReviews = Schema.decodeUnknownEffect(Reviews);
const decodeInstalledPath = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, path: Schema.String }),
);
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const OFFICIAL = "claude-plugins-official";
const OFFICIAL_CLAUDE_STORE = "anthropics/claude-plugins-official";

const pluginNameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const BRANDS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  notion: "Notion",
  figma: "Figma",
  linear: "Linear",
  sentry: "Sentry",
  vercel: "Vercel",
  supabase: "Supabase",
  playwright: "Playwright",
  context7: "Context7",
  adobe: "Adobe",
  atlassian: "Atlassian",
  stripe: "Stripe",
  google: "Google",
  microsoft: "Microsoft",
  salesforce: "Salesforce",
  openai: "OpenAI",
  anthropic: "Anthropic",
};
export function sharedPluginDisplayName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .map(
      (part) =>
        BRANDS[part.toLowerCase()] ??
        (/^(api|ai|mcp|sql|pdf|csv|html|css|sdk|ui|ux|aws)$/i.test(part)
          ? part.toUpperCase()
          : part.charAt(0).toUpperCase() + part.slice(1)),
    )
    .join(" ");
}
export function sharedPluginShelfRank(
  name: string,
  review?: { readonly state: string; readonly by?: { readonly type: string } | undefined },
): number {
  if (review?.state === "done" && ["anthropic", "partner"].includes(review.by?.type ?? ""))
    return 0;
  return name.split(/[-_]+/).some((part) => BRANDS[part.toLowerCase()]) ? 1 : 2;
}

export const makeSharedPluginStore = Effect.fn("makeSharedPluginStore")(function* (options: {
  readonly kind: "claude" | "scient";
  readonly claudeHome: string;
  readonly agentRoot?: string;
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, { readonly message: string }>;
  readonly installed: () => ReturnType<ProviderPluginActions["listPlugins"]>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const optionalJson = Effect.fn("SharedPluginStore.optionalJson")(function* (file: string) {
    return (yield* fs.exists(file)) ? yield* readPluginJson(file) : undefined;
  });
  const readReviews = () =>
    optionalJson(path.join(options.claudeHome, "plugins", "plugin-directory-cache-v2.json")).pipe(
      Effect.flatMap((raw) =>
        raw === undefined
          ? Effect.succeed([])
          : decodeReviews(raw).pipe(Effect.map((value) => value.listings)),
      ),
      Effect.orElseSucceed(() => []),
    );
  const sources = Effect.fn("SharedPluginStore.sources")(function* () {
    const knownRaw = yield* optionalJson(
      path.join(options.claudeHome, "plugins", "known_marketplaces.json"),
    );
    const known = knownRaw === undefined ? {} : yield* decodeKnown(knownRaw);
    const roots = Object.entries(known)
      .filter(([name]) => options.kind === "claude" || name === OFFICIAL)
      .slice(0, 64)
      .map(([name, entry]) => ({
        name,
        root: entry.installLocation,
        catalog: path.join(entry.installLocation, ".claude-plugin", "marketplace.json"),
        repo: entry.source?.repo ? `https://github.com/${entry.source.repo}` : undefined,
        configured: options.kind === "claude",
        uri: entry.source?.repo ?? entry.source?.url ?? entry.source?.path ?? entry.installLocation,
      }));
    if (options.agentRoot) {
      const raw = yield* optionalJson(path.join(options.agentRoot, "marketplaces.json"));
      const registry = raw === undefined ? { marketplaces: [] } : yield* decodeMarkets(raw);
      for (const entry of registry.marketplaces.slice(0, 64)) {
        const root = [".claude-plugin", ".omp-plugin"].includes(
          path.basename(path.dirname(entry.catalogPath)),
        )
          ? path.dirname(path.dirname(entry.catalogPath))
          : path.dirname(entry.catalogPath);
        const existing = roots.findIndex((item) => item.name === entry.name);
        const source = {
          name: entry.name,
          root,
          catalog: entry.catalogPath,
          repo: entry.sourceUri.startsWith("https://")
            ? entry.sourceUri
            : `https://github.com/${entry.sourceUri}`,
          configured: true,
          uri: entry.sourceUri,
        };
        if (existing >= 0) roots[existing] = source;
        else roots.push(source);
      }
    }
    return roots;
  });
  const listing = Effect.fn("SharedPluginStore.listing")(function* () {
    const roots = yield* sources();
    const reviews = yield* readReviews();
    const native = (yield* options.installed()).plugins;
    const installed = new Set(native.map((item) => item.name));
    const installedPaths = new Map(
      native.flatMap((item): Array<readonly [string, string]> => {
        const parsed = decodeInstalledPath(item);
        return parsed._tag === "Some" && path.isAbsolute(parsed.value.path)
          ? [[parsed.value.name, parsed.value.path]]
          : [];
      }),
    );
    const entries: Array<{
      entry: ProviderStoreEntry;
      root: string;
      pluginDir?: string;
      repo?: string;
      uri: string;
      relative?: string | undefined;
      rank: number;
    }> = [];
    for (const source of roots) {
      const raw = yield* optionalJson(source.catalog);
      if (raw === undefined) continue;
      const catalog = yield* decodeCatalog(raw);
      if (catalog.name !== source.name) continue;
      if (catalog.plugins.length > 10_000 || entries.length + catalog.plugins.length > 20_000)
        return yield* Effect.fail({ message: "The shared store exceeded its entry limit." });
      for (const rawPlugin of catalog.plugins.slice(0, 10_000)) {
        const parsed = decodePlugin(rawPlugin);
        if (parsed._tag === "None") continue;
        const plugin = parsed.value;
        const id = `${plugin.name}@${source.name}`;
        const relative =
          typeof plugin.source === "string" && plugin.source.startsWith("./")
            ? path.join(catalog.metadata?.pluginRoot ?? "", plugin.source)
            : undefined;
        const candidate = relative === undefined ? undefined : path.resolve(source.root, relative);
        const relativeDir =
          candidate &&
          (candidate === path.resolve(source.root) ||
            candidate.startsWith(`${path.resolve(source.root)}${path.sep}`))
            ? candidate
            : undefined;
        const pluginDir = relativeDir ?? installedPaths.get(id);
        const pluginRoot = relativeDir ? source.root : (installedPaths.get(id) ?? source.root);
        const repo =
          typeof plugin.source === "string"
            ? source.repo
            : plugin.source.repo
              ? `https://github.com/${plugin.source.repo}`
              : plugin.source.url;
        const directory = reviews.find(
          (entry) => pluginNameKey(entry.name) === pluginNameKey(plugin.name),
        );
        entries.push({
          rank: sharedPluginShelfRank(plugin.name, directory?.checks?.review),
          root: pluginRoot,
          uri: source.uri,
          ...(pluginDir ? { pluginDir, relative } : {}),
          ...(repo ? { repo } : {}),
          entry: {
            id,
            name: plugin.name,
            marketplace: source.name,
            displayName:
              plugin.displayName?.trim() ||
              (directory?.name.includes(" ")
                ? directory.name
                : sharedPluginDisplayName(directory?.name ?? plugin.name)),
            description: plugin.description ?? "",
            kind: "shared",
            installed: installed.has(id),
            includes: [],
            apps: [],
            ...(plugin.version ? { version: plugin.version } : {}),
            ...(plugin.author?.name ? { publisher: plugin.author.name } : {}),
            ...(plugin.homepage ? { website: plugin.homepage } : {}),
            ...(!source.configured
              ? { disabledReason: "Add Claude Code's store to Scient Agent first." }
              : typeof plugin.source !== "string" && plugin.source.source === "npm"
                ? { disabledReason: "This agent does not support npm marketplace sources yet." }
                : {}),
          },
        });
      }
    }
    return {
      entries,
      officialStoreConfigured: roots.some(
        (source) => source.name === OFFICIAL && source.configured,
      ),
      canAddOfficialStore:
        options.kind === "scient" &&
        !roots.some((source) => source.name === OFFICIAL && source.configured),
    };
  });
  const search: NonNullable<ProviderPluginActions["store"]>["search"] = Effect.fn(
    "SharedPluginStore.search",
  )(
    function* (input: Omit<ProviderStoreSearchInput, "instanceId">) {
      const result = yield* listing();
      const terms = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matching = result.entries.filter(({ entry }) =>
        terms.every((term) =>
          `${entry.name} ${entry.description} ${entry.marketplace}`.toLowerCase().includes(term),
        ),
      );
      if (input.preview)
        matching.sort(
          (a, b) => a.rank - b.rank || a.entry.displayName.localeCompare(b.entry.displayName),
        );
      const offset = input.cursor ? Number(input.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        return yield* Effect.fail({ message: "Invalid store cursor." });
      const limit = Math.min(input.limit ?? (input.preview ? 6 : 30), 50);
      return {
        entries: matching.slice(offset, offset + limit).map((item) => item.entry),
        total: matching.length,
        ...(offset + limit < matching.length ? { nextCursor: String(offset + limit) } : {}),
        canAddOfficialStore: result.canAddOfficialStore,
        officialStoreConfigured: result.officialStoreConfigured,
      } satisfies ProviderStorePage;
    },
    Effect.mapError(() => ({ message: "Could not read the configured plugin marketplaces." })),
  );
  const entry: NonNullable<ProviderPluginActions["store"]>["entry"] = Effect.fn(
    "SharedPluginStore.entry",
  )(
    function* (id: string) {
      const item = (yield* listing()).entries.find((item) => item.entry.id === id);
      if (!item) return yield* Effect.fail({ message: "This plugin is no longer in the store." });
      const includes: string[] = [];
      if (item.pluginDir) {
        const realRoot = yield* fs.realPath(item.root);
        const realPlugin = yield* fs.realPath(item.pluginDir).pipe(Effect.option);
        if (
          realPlugin._tag === "Some" &&
          (realPlugin.value === realRoot || realPlugin.value.startsWith(`${realRoot}${path.sep}`))
        ) {
          for (const [dir, label] of [
            ["skills", "Skills"],
            ["commands", "Commands"],
            ["agents", "Agents"],
            ["hooks", "Hooks"],
          ] as const) {
            if (yield* fs.exists(path.join(realPlugin.value, dir))) includes.push(label);
          }
          for (const file of [".mcp.json", "mcp.json"])
            if (yield* fs.exists(path.join(realPlugin.value, file))) {
              includes.push("MCP servers");
              break;
            }
          const manifest = yield* optionalJson(
            path.join(realPlugin.value, ".claude-plugin", "plugin.json"),
          );
          const record = decodeRecord(manifest);
          if (record._tag === "Some")
            for (const [key, label] of [
              ["skills", "Skills"],
              ["commands", "Commands"],
              ["agents", "Agents"],
              ["hooks", "Hooks"],
              ["mcpServers", "MCP servers"],
            ] as const)
              if (record.value[key] !== undefined && !includes.includes(label))
                includes.push(label);
          const pkg = decodeRecord(
            yield* optionalJson(path.join(realPlugin.value, "package.json")),
          );
          if (pkg._tag === "Some") {
            const omp = decodeRecord(pkg.value.omp);
            if (omp._tag === "Some" && omp.value.extensions) includes.push("Extension modules");
          }
        }
      }
      const reviews = yield* optionalJson(
        path.join(options.claudeHome, "plugins", "plugin-directory-cache-v2.json"),
      ).pipe(
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed([])
            : decodeReviews(raw).pipe(Effect.map((value) => value.listings)),
        ),
        Effect.orElseSucceed(() => []),
      );
      const normalizeRepo = (url: string) =>
        url
          .replace(/\.git$/, "")
          .replace(/\/$/, "")
          .toLowerCase();
      const review = reviews.find(
        (listing) =>
          listing.name.toLowerCase() === item.entry.name.toLowerCase() &&
          item.repo &&
          listing.source?.repository &&
          normalizeRepo(listing.source.repository.url) === normalizeRepo(item.repo) &&
          (listing.source.repository.path ?? "").replace(/^\.\//, "") ===
            (item.relative ?? "").replace(/^\.\//, ""),
      )?.checks?.review;
      const reviewer =
        review?.state !== "done"
          ? undefined
          : review.by?.type === "anthropic"
            ? ("anthropic" as const)
            : review.by?.type === "partner"
              ? ("partner" as const)
              : undefined;
      return { ...item.entry, includes, ...(reviewer ? { review: reviewer } : {}) };
    },
    Effect.mapError(() => ({ message: "Could not read this plugin's details." })),
  );
  const pluginRoot = Effect.fn("SharedPluginStore.pluginRoot")(
    function* (id: string) {
      const item = (yield* listing()).entries.find((item) => item.entry.id === id);
      if (!item?.pluginDir)
        return yield* Effect.fail({ message: "This plugin has not been cloned locally." });
      const root = yield* fs.realPath(item.root);
      const plugin = yield* fs.realPath(item.pluginDir);
      if (plugin !== root && !plugin.startsWith(`${root}${path.sep}`))
        return yield* Effect.fail({ message: "This plugin is outside its marketplace." });
      return plugin;
    },
    Effect.mapError(() => ({ message: "Could not read this plugin's local contents." })),
  );
  return {
    contents: (id) =>
      pluginRoot(id).pipe(
        Effect.flatMap((root) =>
          Effect.tryPromise({
            try: () => readLocalPluginContents(root),
            catch: () => ({ message: "Could not read this plugin's contents." }),
          }),
        ),
      ),
    skillDocument: (id, skillId) =>
      pluginRoot(id).pipe(
        Effect.flatMap((root) =>
          Effect.tryPromise({
            try: () => readLocalPluginSkill(root, skillId),
            catch: () => ({ message: "Could not read this skill document." }),
          }),
        ),
      ),
    search,
    entry,
    marketplaceSource: (id) =>
      listing().pipe(
        Effect.flatMap((value) => {
          const item = value.entries.find((item) => item.entry.id === id);
          return item
            ? Effect.succeed(item.uri)
            : Effect.fail({ message: "This marketplace is no longer configured." });
        }),
        Effect.mapError(() => ({ message: "Could not read the plugin's marketplace source." })),
      ),
    ...(options.kind === "claude"
      ? {
          ensureMarketplace: Effect.fn("SharedPluginStore.ensureMarketplace")(
            function* ({ name, source }: { readonly name: string; readonly source: string }) {
              const normalize = (value: string) =>
                value
                  .replace(/^https:\/\/github.com\//, "")
                  .replace(/^git@github.com:/, "")
                  .replace(/\.git\/?$/, "")
                  .replace(/\/$/, "");
              const existing = (yield* sources()).find(
                (item) => item.name === name && item.configured,
              );
              if (existing) {
                if (normalize(existing.uri) !== normalize(source))
                  return yield* Effect.fail({
                    message: "Claude Code has a different marketplace with this name.",
                  });
                return;
              }
              yield* options.run(["plugin", "marketplace", "add", source]);
              if (!(yield* sources()).some((item) => item.name === name && item.configured))
                return yield* Effect.fail({
                  message: "Claude Code did not confirm the marketplace.",
                });
            },
            Effect.mapError(() => ({ message: "Could not add this marketplace to Claude Code." })),
          ),
        }
      : {}),
    install: (id) =>
      entry(id).pipe(
        Effect.flatMap((plugin) =>
          plugin.disabledReason
            ? Effect.fail({ message: plugin.disabledReason })
            : options.run(["plugin", "install", "--scope", "user", plugin.id]),
        ),
        Effect.asVoid,
      ),
    ...(options.kind === "scient"
      ? {
          addOfficialStore: () =>
            options
              .run(["plugin", "marketplace", "add", OFFICIAL_CLAUDE_STORE])
              .pipe(Effect.asVoid),
        }
      : {}),
  } satisfies NonNullable<ProviderPluginActions["store"]>;
});
