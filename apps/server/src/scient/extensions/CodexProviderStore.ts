import type {
  ProviderStoreEntry,
  ProviderStoreApp,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import { CURATED_SERVERS } from "./discover/curatedCatalog.ts";
import { makeCodexStoreIcons } from "./CodexStoreIcons.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
type Plugin = CodexSchema.V2PluginListResponse__PluginSummary;
type App = CodexSchema.V2AppsListResponse__AppInfo;
type CachedPlugin = {
  readonly plugin: Plugin;
  readonly marketplace: string;
  readonly marketplacePath?: string;
};
const encodeKey = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const CURATED = new Set(
  CURATED_SERVERS.flatMap((entry) => (entry.agentStores?.codex ? [entry.agentStores.codex] : [])),
);
const fail = (message: string) => Effect.fail({ message });

export function codexStoreDisabledReason(plugin: Plugin, plan: string): string | undefined {
  if (plugin.availability === "DISABLED_BY_ADMIN" || plugin.disabledReason === "disabled_by_admin")
    return "Disabled by your administrator";
  if (
    plugin.disabledReason === "plan_not_eligible" ||
    (plugin.eligiblePlanTypes?.length && !plugin.eligiblePlanTypes.includes(plan))
  )
    return plugin.eligiblePlanTypes?.length
      ? `Requires ${plugin.eligiblePlanTypes.join(" or ")}`
      : "Not available on your ChatGPT plan";
  if (plugin.disabledReason === "required_app_unavailable") return "A required app is unavailable";
  if (plugin.installPolicy === "NOT_AVAILABLE") return "Not available for this account";
  return undefined;
}
export function codexAppInstallUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/apps/")
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export const makeCodexProviderStore = Effect.fn("makeCodexProviderStore")(function* <E>(
  open: (cwd: string | undefined) => Effect.Effect<Client, E, Scope.Scope>,
  icon = makeCodexStoreIcons(),
) {
  const lifetime = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const connection = yield* Ref.make<
    { readonly client: Client; readonly scope: Scope.Closeable } | undefined
  >(undefined);
  const cache = yield* Ref.make<
    | {
        readonly key: string;
        readonly at: number;
        readonly entries: ReadonlyArray<CachedPlugin>;
        readonly featured: ReadonlySet<string>;
      }
    | undefined
  >(undefined);
  const pendingAuth = new Map<
    string,
    ReadonlyArray<CodexSchema.V2PluginInstallResponse__AppSummary>
  >();
  let appsFingerprint = "";
  const readApps = Effect.fn("CodexProviderStore.readApps")(function* (client: Client) {
    const apps: App[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      const page = yield* client.request("app/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        forceRefetch: true,
      });
      apps.push(...page.data);
      pages++;
      if (apps.length > 20_000 || pages > 200 || (page.nextCursor && seen.has(page.nextCursor)))
        return yield* fail("Codex did not finish listing its apps.");
      cursor = page.nextCursor ?? undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return apps;
  });
  const getClient = Effect.fn("CodexProviderStore.getClient")(function* () {
    const current = yield* Ref.get(connection);
    if (current) return current.client;
    const scope = yield* Scope.fork(lifetime, "sequential");
    const client = yield* open(undefined).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    yield* client.handleServerNotification("app/list/updated", (notification) =>
      Effect.gen(function* () {
        const key = encodeKey(
          notification.data
            .map((app) => [app.id, app.isAccessible, app.isEnabled, app.installUrl])
            .sort(),
        );
        if (key === appsFingerprint) return;
        appsFingerprint = key;
        yield* lock
          .withPermits(1)(
            readApps(client).pipe(
              Effect.andThen(PubSub.publish(changes, undefined)),
              Effect.timeout("30 seconds"),
              Effect.ignore,
            ),
          )
          .pipe(Effect.forkIn(lifetime));
      }),
    );
    yield* client.handleServerNotification("account/updated", () =>
      Ref.set(cache, undefined).pipe(
        Effect.andThen(Effect.sync(() => pendingAuth.clear())),
        Effect.andThen(PubSub.publish(changes, undefined)),
        Effect.asVoid,
      ),
    );
    yield* Ref.set(connection, { client, scope });
    yield* Effect.sleep("60 seconds").pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* Ref.get(connection))?.client !== client) return;
            yield* Ref.set(connection, undefined);
            yield* Scope.close(scope, Exit.void);
          }),
        ),
      ),
      Effect.forkIn(lifetime),
    );
    return client;
  });
  const withClient = Effect.fn("CodexProviderStore.withClient")(
    function* <A, Err>(run: (client: Client) => Effect.Effect<A, Err>) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const client = yield* getClient();
          return yield* run(client);
        }).pipe(
          Effect.timeout("35 seconds"),
          Effect.onError(() =>
            Effect.gen(function* () {
              const previous = yield* Ref.getAndSet(connection, undefined);
              if (previous) yield* Scope.close(previous.scope, Exit.void);
            }),
          ),
        ),
      );
    },
    Effect.mapError(() => ({
      message: "Codex could not finish the store request. Refresh to try again.",
    })),
  );
  const state = Effect.fn("CodexProviderStore.state")(function* (client: Client, refresh = false) {
    const account = (yield* client.request("account/read", { refreshToken: false })).account;
    if (account?.type !== "chatgpt") {
      yield* Ref.set(cache, undefined);
      pendingAuth.clear();
      return undefined;
    }
    const now = yield* Clock.currentTimeMillis;
    const key = encodeKey([account.email, account.planType]);
    let store = yield* Ref.get(cache);
    if (store?.key !== key) {
      store = undefined;
      pendingAuth.clear();
    }
    if (!store || refresh || now - store.at >= 3_600_000) {
      const response = yield* client.request("plugin/list", { forceRefetch: refresh });
      if (response.marketplaceLoadErrors?.length)
        return yield* fail("Codex could not read all its marketplaces.");
      const entries = response.marketplaces.flatMap((marketplace): CachedPlugin[] =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          marketplace: marketplace.name,
          ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
        })),
      );
      if (entries.length > 20_000) return yield* fail("The Codex store exceeded its entry limit.");
      store = { key, at: now, entries, featured: new Set(response.featuredPluginIds ?? []) };
      yield* Ref.set(cache, store);
    }
    const installed = yield* client.request("plugin/installed", {});
    if (installed.marketplaceLoadErrors?.length)
      return yield* fail("Codex did not list all installed plugins.");
    const installedIds = new Set(
      installed.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id),
      ),
    );
    return { store, installedIds, plan: account.planType };
  });
  const project = Effect.fn("CodexProviderStore.project")(function* (
    item: CachedPlugin,
    plan: string,
    installed: boolean,
    apps: ReadonlyArray<App> = [],
    includeIcon = true,
  ) {
    const plugin = item.plugin;
    const info = plugin.interface;
    const iconUrl = includeIcon ? yield* icon(info?.logoUrl) : undefined;
    const disabledReason = codexStoreDisabledReason(plugin, plan);
    const entryApps = apps.filter((app) =>
      app.pluginDisplayNames?.includes(info?.displayName ?? plugin.name),
    );
    return {
      id: plugin.id,
      name: plugin.name,
      marketplace: item.marketplace,
      displayName: info?.displayName?.trim() || plugin.name,
      description: info?.shortDescription?.trim() || info?.longDescription?.trim() || "",
      kind: "codex",
      installed,
      includes: [],
      apps: entryApps.map((app): ProviderStoreApp => ({
        name: app.name,
        connected: app.isAccessible === true,
        enabled: app.isEnabled !== false,
        ...(codexAppInstallUrl(app.installUrl)
          ? { installUrl: codexAppInstallUrl(app.installUrl) }
          : {}),
      })),
      authPolicy: plugin.authPolicy,
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(info?.developerName ? { publisher: info.developerName } : {}),
      ...(info?.websiteUrl ? { website: info.websiteUrl } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(disabledReason ? { disabledReason } : {}),
    } satisfies ProviderStoreEntry;
  });
  const search: NonNullable<ProviderPluginActions["store"]>["search"] = (input) =>
    withClient(
      Effect.fn("CodexProviderStore.search")(function* (client: Client) {
        const current = yield* state(client, input.refresh);
        if (!current)
          return {
            entries: [],
            total: 0,
            message: "Sign in to Codex with ChatGPT to browse its apps.",
          };
        const query = (input.query ?? "").trim().toLowerCase();
        const terms = query.split(/\s+/).filter(Boolean);
        const matching = current.store.entries.filter(({ plugin }) => {
          if (input.preview && CURATED.has(plugin.name)) return false;
          if (
            input.preview &&
            !query &&
            !current.store.featured.has(plugin.id) &&
            !current.installedIds.has(plugin.id)
          )
            return false;
          return terms.every((term) =>
            `${plugin.name} ${plugin.interface?.displayName ?? ""} ${plugin.interface?.shortDescription ?? ""}`
              .toLowerCase()
              .includes(term),
          );
        });
        const cursor = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          return yield* fail("Invalid store cursor.");
        const limit = Math.min(input.limit ?? 30, 50);
        const page = matching.slice(cursor, cursor + limit);
        const apps = page.some(({ plugin }) => current.installedIds.has(plugin.id))
          ? yield* readApps(client)
          : [];
        return {
          entries: yield* Effect.forEach(
            page,
            (item) => project(item, current.plan, current.installedIds.has(item.plugin.id), apps),
            { concurrency: 4 },
          ).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.forEach(page, (item) =>
                    project(
                      item,
                      current.plan,
                      current.installedIds.has(item.plugin.id),
                      apps,
                      false,
                    ),
                  ),
              }),
            ),
          ),
          total: matching.length,
          ...(cursor + limit < matching.length ? { nextCursor: String(cursor + limit) } : {}),
        };
      }),
    );
  const entry: NonNullable<ProviderPluginActions["store"]>["entry"] = (id) =>
    withClient(
      Effect.fn("CodexProviderStore.entry")(function* (client: Client) {
        const current = yield* state(client);
        const item = current?.store.entries.find(({ plugin }) => plugin.id === id);
        if (!current || !item) return yield* fail("This Codex plugin is no longer available.");
        const detail = yield* client.request("plugin/read", {
          pluginName: item.plugin.name,
          ...(item.marketplacePath
            ? { marketplacePath: item.marketplacePath }
            : { remoteMarketplaceName: item.marketplace }),
        });
        const apps = yield* readApps(client);
        const indexedApps = new Map(apps.map((app) => [app.id, app]));
        const references = new Map(
          [...detail.plugin.apps, ...(pendingAuth.get(id) ?? [])].map((app) => [app.id, app]),
        );
        const summary = yield* project(item, current.plan, current.installedIds.has(id));
        return {
          ...summary,
          description: detail.plugin.description ?? summary.description,
          includes: [
            ...detail.plugin.skills.map((skill) => `Skill: ${skill.name}`),
            ...detail.plugin.mcpServers.map((server) => `MCP server: ${server}`),
            ...(detail.plugin.hooks.length ? ["Hooks"] : []),
          ],
          apps: [...references.values()].map((reference): ProviderStoreApp => {
            const app = indexedApps.get(reference.id);
            const url = codexAppInstallUrl(app?.installUrl ?? reference.installUrl);
            return {
              name: app?.name ?? reference.name,
              connected: app?.isAccessible === true,
              enabled: app?.isEnabled !== false,
              ...(url ? { installUrl: url } : {}),
            };
          }),
        };
      }),
    );
  const install: NonNullable<ProviderPluginActions["store"]>["install"] = (id) =>
    withClient(
      Effect.fn("CodexProviderStore.install")(function* (client: Client) {
        const current = yield* state(client, true);
        const item = current?.store.entries.find(({ plugin }) => plugin.id === id);
        if (!current || !item) return yield* fail("This Codex plugin is no longer available.");
        const reason = codexStoreDisabledReason(item.plugin, current.plan);
        if (reason) return yield* fail(reason);
        const response = yield* client.request("plugin/install", {
          pluginName: item.plugin.name,
          ...(item.marketplacePath
            ? { marketplacePath: item.marketplacePath }
            : { remoteMarketplaceName: item.marketplace }),
        });
        pendingAuth.set(id, response.appsNeedingAuth);
        yield* PubSub.publish(changes, undefined);
        return {
          authPolicy: response.authPolicy,
          appsNeedingAuth: response.appsNeedingAuth.map((app): ProviderStoreApp => {
            const url = codexAppInstallUrl(app.installUrl);
            return {
              name: app.name,
              connected: false,
              enabled: true,
              ...(url ? { installUrl: url } : {}),
            };
          }),
        };
      }),
    );
  const enrichInstalled = (plugins: ReadonlyArray<ServerProviderPlugin>) =>
    withClient(
      Effect.fn("CodexProviderStore.enrichInstalled")(function* (client: Client) {
        const account = (yield* client.request("account/read", { refreshToken: false })).account;
        if (account?.type !== "chatgpt") return plugins;
        const apps = yield* readApps(client);
        return plugins.map((plugin) => ({
          ...plugin,
          apps: apps
            .filter((app) => app.pluginDisplayNames?.includes(plugin.displayName ?? plugin.name))
            .map((app): ProviderStoreApp => {
              const url = codexAppInstallUrl(app.installUrl);
              return {
                name: app.name,
                connected: app.isAccessible === true,
                enabled: app.isEnabled !== false,
                ...(url ? { installUrl: url } : {}),
              };
            }),
        }));
      }),
    );
  return { search, entry, install, changes: Stream.fromPubSub(changes), enrichInstalled };
});
