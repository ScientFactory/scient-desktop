import type {
  ExtensionPluginContents,
  ProviderStoreEntry,
  ProviderStoreApp,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import { storeCategories } from "@t3tools/contracts";
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
import {
  codexSkillRoot,
  readLocalPluginRequiredKeys,
  readContainedPluginText,
  readContainedPluginIcon,
} from "./LocalPluginContents.ts";
import { sharedPluginDisplayName } from "./SharedPluginStore.ts";
import { resolveBrandIcon } from "./BrandIcons.ts";
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
const pluginVersionKey = (item: CachedPlugin) =>
  encodeKey([
    item.marketplace,
    item.plugin.id,
    item.plugin.version,
    item.plugin.localVersion,
    item.plugin.remotePluginId,
    item.plugin.source,
  ]);
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
  pluginCacheRoot?: string,
) {
  const lifetime = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const stateLock = yield* Semaphore.make(1);
  const detailLocks = new Map<string, Semaphore.Semaphore>();
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const connection = yield* Ref.make<
    { readonly client: Client; readonly scope: Scope.Closeable } | undefined
  >(undefined);
  const activeOperations = yield* Ref.make(0);
  const cache = yield* Ref.make<
    | {
        readonly key: string;
        readonly details: Map<string, CodexSchema.V2PluginReadResponse__PluginDetail>;
        readonly documents: Map<string, string>;
        readonly at: number;
        readonly entries: ReadonlyArray<CachedPlugin>;
        readonly featured: ReadonlySet<string>;
        readonly installedIds: ReadonlySet<string>;
        readonly installedAt: number;
        readonly complete: boolean;
      }
    | undefined
  >(undefined);
  const pendingAuth = new Map<
    string,
    {
      readonly key: string;
      readonly apps: ReadonlyArray<CodexSchema.V2PluginInstallResponse__AppSummary>;
    }
  >();
  let appsFingerprint = "";
  const readApps = Effect.fn("CodexProviderStore.readApps")(function* (
    client: Client,
    references: ReadonlyArray<CodexSchema.V2PluginReadResponse__AppSummary>,
    refresh = false,
    includeTools = false,
  ) {
    const ids = [...new Set(references.map((app) => app.id))];
    if (!ids.length) return [];
    const installed = yield* client.request("app/installed", { forceRefresh: refresh });
    const states = new Map(installed.apps.map((app) => [app.id, app]));
    const apps: Array<
      App & Pick<CodexSchema.V2AppsReadResponse__ConnectorMetadata, "toolSummaries">
    > = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const page = yield* client.request("app/read", {
        appIds: ids.slice(offset, offset + 100),
        includeTools,
      });
      apps.push(
        ...page.apps.map((app) => ({
          ...app,
          ...(app.iconUrl ? { logoUrl: app.iconUrl } : {}),
          isAccessible: states.has(app.id),
          isEnabled: states.get(app.id)?.enabled ?? true,
        })),
      );
    }
    return apps;
  });
  const projectApps = Effect.fn("CodexProviderStore.projectApps")(function* (
    client: Client,
    references: ReadonlyArray<CodexSchema.V2PluginReadResponse__AppSummary>,
    includeTools = false,
  ) {
    const selected = references.slice(0, 200);
    const apps = new Map(
      (yield* readApps(client, selected, false, includeTools)).map((app) => [app.id, app]),
    );
    return yield* Effect.forEach(
      selected,
      Effect.fn("CodexProviderStore.app")(function* (reference) {
        const app = apps.get(reference.id);
        const url = codexAppInstallUrl(app?.installUrl ?? reference.installUrl);
        const iconUrl =
          resolveBrandIcon(app?.name ?? reference.name) ??
          (yield* icon(app?.logoUrl).pipe(
            Effect.timeoutOption("1 second"),
            Effect.map(Option.getOrUndefined),
          ));
        return {
          id: reference.id,
          name: app?.name ?? reference.name,
          ...(app?.description || reference.description
            ? { description: app?.description ?? reference.description! }
            : {}),
          ...(includeTools && app?.toolSummaries
            ? {
                toolCounts: {
                  read: app.toolSummaries.filter((tool) => tool.isReadOnly === true).length,
                  write: app.toolSummaries.filter((tool) => tool.isReadOnly !== true).length,
                },
                toolSummaries: app.toolSummaries.slice(0, 200).map((tool) => ({
                  name: tool.name.slice(0, 500),
                  ...(tool.title ? { title: tool.title.slice(0, 500) } : {}),
                  description: tool.description.slice(0, 4000),
                  isReadOnly: tool.isReadOnly === true,
                  isEnabled: tool.isEnabled !== false,
                })),
              }
            : {}),
          connected: app?.isAccessible === true,
          enabled: app?.isEnabled !== false,
          ...(iconUrl ? { iconUrl } : {}),
          ...(url ? { installUrl: url } : {}),
        };
      }),
      { concurrency: 4 },
    );
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
        yield* PubSub.publish(changes, undefined);
      }),
    );
    yield* client.handleServerNotification("account/updated", () =>
      Ref.set(cache, undefined).pipe(
        Effect.andThen(
          Effect.sync(() => {
            pendingAuth.clear();
          }),
        ),
        Effect.andThen(PubSub.publish(changes, undefined)),
        Effect.asVoid,
      ),
    );
    yield* Ref.set(connection, { client, scope });
    return client;
  });
  const withClient = Effect.fn("CodexProviderStore.withClient")(
    function* <A, Err>(run: (client: Client) => Effect.Effect<A, Err>) {
      const client = yield* lock.withPermits(1)(getClient());
      yield* Ref.update(activeOperations, (count) => count + 1);
      return yield* run(client).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            // One failed or slow operation must not tear down the shared
            // client while other operations are still using it; the last
            // failing operation resets it.
            if ((yield* Ref.get(activeOperations)) > 1) return;
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                if ((yield* Ref.get(connection))?.client !== client) return;
                const previous = yield* Ref.getAndSet(connection, undefined);
                yield* Ref.set(cache, undefined);
                if (previous) yield* Scope.close(previous.scope, Exit.void);
              }),
            );
          }),
        ),
        Effect.ensuring(Ref.update(activeOperations, (count) => count - 1)),
      );
    },
    // A cold app-server's first catalog reads can take well over 15 seconds
    // in the real server; the budget must outlast them or every retry starts
    // cold again.
    Effect.timeout("35 seconds"),
    Effect.mapError((cause) => ({
      message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "object" &&
              cause !== null &&
              "message" in cause &&
              typeof cause.message === "string"
            ? cause.message
            : "Codex could not finish the store request. Refresh to check its current state.",
    })),
  );
  const state = Effect.fn("CodexProviderStore.state")(function* (
    client: Client,
    refresh = false,
    localOnly = false,
  ) {
    return yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const account = (yield* client.request("account/read", { refreshToken: false })).account;
        if (account?.type !== "chatgpt") {
          yield* Ref.set(cache, undefined);
          pendingAuth.clear();
          return undefined;
        }
        const now = yield* Clock.currentTimeMillis;
        const key = encodeKey([account.email, account.planType]);
        let store = yield* Ref.get(cache);
        const previous = store?.key === key ? store : undefined;
        if ((store && (store.key !== key || now - store.at >= 3_600_000)) || refresh) {
          store = undefined;
          pendingAuth.clear();
        }
        if (!store || (!localOnly && !store.complete)) {
          const response = localOnly
            ? undefined
            : yield* client.request("plugin/list", { forceRefetch: refresh });
          if (response?.marketplaceLoadErrors?.length)
            return yield* fail("Codex could not read all its marketplaces.");
          const entries =
            response?.marketplaces.flatMap((marketplace): CachedPlugin[] =>
              marketplace.plugins.map((plugin) => ({
                plugin,
                marketplace: marketplace.name,
                ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
              })),
            ) ?? [];
          if (entries.length > 20_000)
            return yield* fail("The Codex store exceeded its entry limit.");
          store = {
            key,
            details: previous?.details ?? new Map(),
            documents: previous?.documents ?? new Map(),
            at: now,
            entries,
            featured: new Set(response?.featuredPluginIds ?? []),
            installedIds: new Set<string>(),
            installedAt: -Infinity,
            complete: !localOnly,
          };
        }
        if (now - store.installedAt >= 30_000) {
          const installed = yield* client.request("plugin/installed", {});
          if (installed.marketplaceLoadErrors?.length)
            return yield* fail("Codex did not list all installed plugins.");
          const installedIds = new Set(
            installed.marketplaces.flatMap((marketplace) =>
              marketplace.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id),
            ),
          );
          const known = new Set(store.entries.map(({ plugin }) => plugin.id));
          const localEntries = installed.marketplaces.flatMap((marketplace) =>
            marketplace.plugins
              .filter((plugin) => !known.has(plugin.id))
              .map((plugin) => ({
                plugin,
                marketplace: marketplace.name,
                ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
              })),
          );
          store = {
            ...store,
            entries: [...store.entries, ...localEntries],
            installedIds,
            installedAt: now,
          };
        }
        yield* Ref.set(cache, store);
        return { store, installedIds: store.installedIds, plan: account.planType };
      }),
    );
  });
  const readDetail = Effect.fn("CodexProviderStore.readDetail")(function* (
    client: Client,
    item: CachedPlugin,
    generation: Map<string, CodexSchema.V2PluginReadResponse__PluginDetail>,
  ) {
    const versionKey = encodeKey([
      pluginVersionKey(item),
      item.plugin.enabled,
      item.plugin.installed,
    ]);
    let detailLock = detailLocks.get(versionKey);
    if (!detailLock) {
      detailLock = Semaphore.makeUnsafe(1);
      detailLocks.set(versionKey, detailLock);
    }
    return yield* detailLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = generation.get(versionKey);
        if (cached) return cached;
        const detail = (yield* client.request("plugin/read", {
          pluginName: item.plugin.name,
          ...(item.marketplacePath
            ? { marketplacePath: item.marketplacePath }
            : { remoteMarketplaceName: item.marketplace }),
        })).plugin;
        if (generation.size >= 256) generation.delete(generation.keys().next().value!);
        generation.set(versionKey, detail);
        return detail;
      }),
    );
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
    const root = plugin.source.type === "local" ? plugin.source.path : undefined;
    const bundledIcon = includeIcon
      ? (resolveBrandIcon(info?.displayName ?? "") ?? resolveBrandIcon(plugin.name))
      : undefined;
    const localIcon =
      !bundledIcon && root && (info?.logo || info?.composerIcon) && includeIcon
        ? yield* Effect.tryPromise(() =>
            readContainedPluginIcon(root, (info?.logo || info?.composerIcon)!),
          ).pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
    const iconUrl =
      bundledIcon ??
      localIcon ??
      (includeIcon
        ? yield* icon(info?.logoUrl).pipe(
            Effect.timeoutOption("1 second"),
            Effect.map(Option.getOrUndefined),
          )
        : undefined);
    const disabledReason = codexStoreDisabledReason(plugin, plan);
    const entryApps = apps.filter((app) =>
      app.pluginDisplayNames?.includes(info?.displayName ?? plugin.name),
    );
    return {
      id: plugin.id,
      name: plugin.name,
      marketplace: item.marketplace,
      displayName: info?.displayName?.trim() || sharedPluginDisplayName(plugin.name),
      description: info?.shortDescription?.trim() || info?.longDescription?.trim() || "",
      kind: "codex",
      ...(info?.category ? { category: info.category } : {}),
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
          if (
            input.category &&
            !storeCategories(plugin.name, plugin.interface?.category ?? undefined).some(
              (category) => category === input.category,
            )
          )
            return false;
          if (input.preview && current.installedIds.has(plugin.id)) return false;
          if (input.preview && !query && !current.store.featured.has(plugin.id)) return false;
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
        return {
          entries: yield* Effect.forEach(
            page,
            (item) => project(item, current.plan, current.installedIds.has(item.plugin.id)),
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
                      [],
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
        const findEntry = (entries: ReadonlyArray<CachedPlugin> | undefined) => {
          const exact = entries?.find(({ plugin }) => plugin.id === id);
          if (exact) return exact;
          const named = entries?.filter(({ plugin }) => plugin.name === id);
          return named?.length === 1 ? named[0] : undefined;
        };
        let current = yield* state(client, false, true);
        let item = findEntry(current?.store.entries);
        if (!item) {
          current = yield* state(client);
          item = findEntry(current?.store.entries);
        }
        if (!current || !item) return yield* fail("This Codex plugin is no longer available.");
        const detail = yield* readDetail(client, item, current.store.details);
        const pending = pendingAuth.get(item.plugin.id);
        const references = new Map(
          [...detail.apps, ...(pending?.key === current.store.key ? pending.apps : [])].map(
            (app) => [app.id, app],
          ),
        );
        const summary = yield* project(
          item,
          current.plan,
          current.installedIds.has(item.plugin.id),
        );
        return {
          ...summary,
          tagline: summary.description,
          description: detail.description ?? summary.description,
          includes: [
            ...detail.skills.map((skill) => `Skill: ${skill.name}`),
            ...detail.mcpServers.map((server) => `MCP server: ${server}`),
            ...(detail.hooks.length ? ["Hooks"] : []),
          ],
          apps: yield* projectApps(client, [...references.values()]),
        };
      }),
    );
  const install: NonNullable<ProviderPluginActions["store"]>["install"] = (id) =>
    withClient(
      Effect.fn("CodexProviderStore.install")(function* (client: Client) {
        const current = yield* state(client);
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
        yield* Ref.set(cache, undefined);
        pendingAuth.set(id, { key: current.store.key, apps: response.appsNeedingAuth });
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
  const detailFor = Effect.fn("CodexProviderStore.detailFor")(function* (
    client: Client,
    id: string,
  ) {
    const cached = yield* Ref.get(cache);
    const cachedItem = cached?.entries.find(({ plugin }) => plugin.id === id);
    if (cached && cachedItem)
      return {
        detail: yield* readDetail(client, cachedItem, cached.details),
        item: cachedItem,
        installed: cached.installedIds.has(id),
        documents: cached.documents,
      };
    let current = yield* state(client, false, true);
    let item = current?.store.entries.find(({ plugin }) => plugin.id === id);
    if (!item) {
      current = yield* state(client);
      item = current?.store.entries.find(({ plugin }) => plugin.id === id);
    }
    if (!current || !item) return yield* fail("This plugin is no longer available.");
    const detail = yield* readDetail(client, item, current.store.details);
    return {
      detail,
      item,
      installed: current.installedIds.has(id),
      documents: current.store.documents,
    };
  });
  const skillRoot = (detail: CodexSchema.V2PluginReadResponse__PluginDetail, file: string) => {
    const source = detail.summary?.source;
    const root =
      source && (source.type === "local" || source.type === "git")
        ? (source.path ?? undefined)
        : undefined;
    return Effect.tryPromise(() => codexSkillRoot(root, pluginCacheRoot, file)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  };
  const localKeyRoot = Effect.fn("CodexProviderStore.localKeyRoot")(function* (
    detail: CodexSchema.V2PluginReadResponse__PluginDetail,
    item: CachedPlugin,
    installed: boolean,
  ) {
    if (!installed) return undefined;
    const source = detail.summary?.source ?? item.plugin.source;
    if ((source.type === "local" || source.type === "git") && source.path) return source.path;
    for (const skill of detail.skills.slice(0, 200)) {
      const root = skill.path ? yield* skillRoot(detail, skill.path) : undefined;
      if (root) return root;
    }
    return undefined;
  });
  const contents = (id: string) =>
    withClient(
      Effect.fn("CodexProviderStore.contents")(function* (client: Client) {
        const { detail, item, installed } = yield* detailFor(client, id);
        const root = yield* localKeyRoot(detail, item, installed);
        const requiredKeys =
          installed && root
            ? yield* Effect.tryPromise(() => readLocalPluginRequiredKeys(root)).pipe(
                Effect.orElseSucceed(() => undefined),
              )
            : undefined;
        return {
          ...(requiredKeys === undefined ? {} : { requiredKeys }),
          apps: yield* projectApps(client, detail.apps, true),
          mcpServers: detail.mcpServers.slice(0, 200).map((name) => ({ name })),
          skills: yield* Effect.forEach(
            detail.skills.slice(0, 200),
            Effect.fn("CodexProviderStore.skillSummary")(function* (skill) {
              const root = skill.path ? yield* skillRoot(detail, skill.path) : undefined;
              return {
                id: skill.name,
                name: skill.name,
                displayName:
                  skill.interface?.displayName?.trim() ||
                  sharedPluginDisplayName(skill.name.split(":").at(-1) ?? skill.name),
                ...(skill.path ? { path: skill.path } : {}),
                description:
                  skill.interface?.shortDescription ??
                  skill.shortDescription ??
                  skill.description ??
                  "",
                enabled: installed && detail.summary?.enabled !== false && skill.enabled !== false,
                documentAvailable: root !== undefined || Boolean(item.plugin.remotePluginId),
              };
            }),
          ),
          hooks: detail.hooks.slice(0, 200).map((hook) => hook.eventName),
          commands: [],
          agents: [],
        } satisfies ExtensionPluginContents;
      }),
    );
  const keyServerRoot = (id: string) =>
    withClient(
      Effect.fn("CodexProviderStore.keyServerRoot")(function* (client: Client) {
        const { detail, item, installed } = yield* detailFor(client, id);
        return yield* localKeyRoot(detail, item, installed);
      }),
    );
  const skillDocument = (id: string, skillId: string) =>
    withClient(
      Effect.fn("CodexProviderStore.skillDocument")(function* (client: Client) {
        const { detail, item, documents } = yield* detailFor(client, id);
        const skill = detail.skills.slice(0, 200).find((skill) => skill.name === skillId);
        const documentKey = encodeKey([pluginVersionKey(item), skillId]);
        const cached = documents.get(documentKey);
        if (cached !== undefined) return { instructions: cached };
        const root = skill?.path ? yield* skillRoot(detail, skill.path) : undefined;
        if (!skill) return yield* fail("This skill is no longer available.");
        const remotePluginId = item.plugin.remotePluginId;
        const text =
          root && skill.path
            ? yield* Effect.tryPromise(() => readContainedPluginText(root, skill.path!)).pipe(
                Effect.mapError(() => ({
                  message: "This skill must stay within its plugin and be at most 256 KB.",
                })),
              )
            : remotePluginId
              ? (yield* client.request("plugin/skill/read", {
                  remoteMarketplaceName: item.marketplace,
                  remotePluginId,
                  skillName: skill.name,
                })).contents
              : undefined;
        if (text == null) return yield* fail("Install this plugin to read its skill documents.");
        if (new TextEncoder().encode(text).length > 256 * 1024)
          return yield* fail("This skill must be at most 256 KB.");
        const instructions = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
        if (documents.size >= 128) documents.delete(documents.keys().next().value!);
        documents.set(documentKey, instructions);
        return { instructions };
      }),
    );
  const enrichInstalled = (plugins: ReadonlyArray<ServerProviderPlugin>, refresh = false) =>
    withClient(
      Effect.fn("CodexProviderStore.enrichInstalled")(function* (client: Client) {
        const cached = yield* Ref.get(cache);
        if (cached) yield* Ref.set(cache, { ...cached, installedAt: -Infinity });
        const current = yield* state(client, false, true);
        if (!current) return plugins;
        const references = yield* Effect.forEach(
          plugins,
          Effect.fn("CodexProviderStore.installedApps")(function* (plugin) {
            const item = current.store.entries.find((item) => item.plugin.id === plugin.id);
            if (!item) return [];
            return (yield* readDetail(client, item, current.store.details)).apps;
          }),
        );
        const apps = yield* readApps(client, references.flat(), refresh);
        return plugins.map((plugin, index) => ({
          ...plugin,
          apps: apps
            .filter((app) => references[index]?.some((reference) => reference.id === app.id))
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
  return {
    contents,
    keyServerRoot,
    skillDocument,
    search,
    entry,
    install,
    changes: Stream.fromPubSub(changes),
    enrichInstalled,
  };
});
