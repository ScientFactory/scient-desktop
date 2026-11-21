/**
 * The Antigravity Marketplace in Scient: Google's two catalogs, added through `agy plugin install`
 * of a checked archive into the OS user's Antigravity plugins (shared with their Antigravity app),
 * removed with `agy plugin uninstall`. A small receipt per Add records which catalog entry an
 * installed folder came from, since agy's own listing does not.
 */
import type {
  ExtensionPluginContents,
  ProviderStoreEntry,
  ProviderStorePage,
  ProviderStoreSearchInput,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import type {
  ProviderNativeInventory,
  ProviderPluginActions,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { nextInventoryReadSequence } from "../../provider/ProviderNativeInventory.ts";
import type {
  AntigravityExecutable,
  AntigravityInstallationError,
} from "../../provider/AntigravityInstallation.ts";
import {
  ANTIGRAVITY_MARKETPLACES,
  AntigravityPluginName,
  makeAntigravityPluginCatalog,
  type AntigravityCatalogPlugin,
  type AntigravityMarketplace,
} from "./AntigravityPluginCatalog.ts";
import {
  isAntigravityPluginArchiveError,
  stageAntigravityPlugin,
} from "./AntigravityPluginArchive.ts";
import { resolveBrandIcon } from "./BrandIcons.ts";
import { readLocalPluginContents, readLocalPluginSkill } from "./LocalPluginContents.ts";
import { tryLocalPluginRead } from "./LocalPluginFiles.ts";
import { runProviderPluginCommand } from "./ProviderPluginCommand.ts";
import { sharedPluginDisplayName } from "./SharedPluginStore.ts";

type Failure = { readonly message: string };
const fail = (message: string) => Effect.fail({ message } satisfies Failure);

const MAX_LISTED = 2_000;
const Listed = Schema.Array(
  Schema.Struct({
    name: AntigravityPluginName,
    enabled: Schema.Boolean,
    version: Schema.optional(Schema.NullOr(Schema.String)),
    source: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.String,
    skills: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    mcpServers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
).check(Schema.isMaxLength(MAX_LISTED));
const decodeListed = Schema.decodeUnknownEffect(Schema.fromJsonString(Listed));

const Receipt = Schema.Struct({
  name: AntigravityPluginName,
  marketplace: Schema.Literals(ANTIGRAVITY_MARKETPLACES.map((item) => item.name)),
  version: Schema.optional(Schema.String),
  sha256: Schema.String,
  path: Schema.String,
  displayName: Schema.optional(Schema.String),
});
type Receipt = typeof Receipt.Type;
const ReceiptFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    receipts: Schema.Array(Receipt).check(Schema.isMaxLength(MAX_LISTED)),
  }),
);
const decodeReceipts = Schema.decodeUnknownEffect(ReceiptFile);
const encodeReceipts = Schema.encodeEffect(ReceiptFile);

/** One plugin `agy plugin list --json` reported, with its folder. */
export type AntigravityInstalledPlugin = ServerProviderPlugin & {
  readonly path: string;
  readonly skills: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
};

const entryId = (name: string, marketplace: string) => `${name}@${marketplace}`;

export const ANTIGRAVITY_NOT_CLI =
  "Adding plugins needs Antigravity's agy command-line runtime. Choose it in this agent's settings.";
const INVENTORY_UNAVAILABLE =
  "Scient could not read Antigravity's installed plugins, so Add and Remove are paused. Refresh to try again.";

/** Which listed plugin a receipt vouches for: same name, same folder and, when known, same version. */
function receiptFor(
  receipts: ReadonlyArray<Receipt>,
  plugin: { readonly name: string; readonly path: string; readonly version?: string | undefined },
): Receipt | undefined {
  return receipts.find(
    (receipt) =>
      receipt.name === plugin.name &&
      receipt.path === plugin.path &&
      (receipt.version === undefined ||
        plugin.version === undefined ||
        receipt.version === plugin.version),
  );
}

/** `agy plugin list --json` as provider plugins; any malformed listing fails as a whole. */
const parseAntigravityPluginList = Effect.fn("AntigravityProviderStore.parseList")(function* (
  output: string,
  receipts: ReadonlyArray<Receipt>,
) {
  const path = yield* Path.Path;
  const listed = yield* decodeListed(output.trim());
  const names = new Set<string>();
  const plugins: AntigravityInstalledPlugin[] = [];
  for (const item of listed) {
    if (names.has(item.name) || !path.isAbsolute(item.path))
      return yield* fail("Antigravity listed its plugins in an unexpected form.");
    names.add(item.name);
    const version = item.version?.trim() || undefined;
    const receipt = receiptFor(receipts, { name: item.name, path: item.path, version });
    plugins.push({
      id: receipt ? entryId(item.name, receipt.marketplace) : `antigravity:${item.name}`,
      name: item.name,
      displayName: receipt?.displayName?.trim() || sharedPluginDisplayName(item.name),
      ...(version ? { version } : {}),
      ...(receipt ? { marketplace: receipt.marketplace } : {}),
      source: "local",
      enabled: item.enabled,
      canUninstall: true,
      canSetEnabled: true,
      sourceLabel: receipt ? "Antigravity Marketplace" : "Antigravity's plugins",
      scope: "user",
      path: item.path,
      skills: item.skills ?? [],
      mcpServers: item.mcpServers ?? [],
    });
  }
  return plugins;
});

/** Contents a catalog entry declares, before it is added; folders are read once it is. */
function declaredContents(plugin: AntigravityCatalogPlugin): ExtensionPluginContents {
  return {
    deferred: true,
    apps: [],
    agents: [],
    commands: [],
    mcpServers: plugin.mcpServers.map((name) => ({ name })),
    skills: plugin.skills.map((name) => ({
      id: name,
      name,
      description: "",
      enabled: false,
      documentAvailable: false,
    })),
  };
}

export interface AntigravityPluginStoreOptions {
  /** Scient's state folder: receipts and the private staging folder live under it. */
  readonly stateDir: string;
  /** Runs this instance's `agy` with fixed arguments, or fails with why it cannot. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, Failure>;
  /** Why this instance cannot manage plugins (it is not the agy CLI), or `undefined`. */
  readonly unavailable: Effect.Effect<string | undefined>;
  readonly marketplaces?: ReadonlyArray<AntigravityMarketplace>;
}

export const makeAntigravityPluginActions = Effect.fn("makeAntigravityPluginActions")(function* (
  options: AntigravityPluginStoreOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const catalog = yield* makeAntigravityPluginCatalog(options.marketplaces);
  const root = path.join(options.stateDir, "antigravity-plugins");
  const receiptsFile = path.join(root, "receipts.json");
  const stagingRoot = path.join(root, "staging");
  const reports = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderNativeInventory>({ replay: 1 }),
    PubSub.shutdown,
  );
  const retired = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
  const writes = yield* Semaphore.make(1);

  const readReceipts = fs.exists(receiptsFile).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fs.readFileString(receiptsFile).pipe(
            Effect.flatMap(decodeReceipts),
            Effect.map((file) => file.receipts),
          )
        : Effect.succeed([]),
    ),
    Effect.tapError(() =>
      Effect.logWarning("Ignoring an unreadable Antigravity plugin receipt file."),
    ),
    Effect.orElseSucceed((): ReadonlyArray<Receipt> => []),
  );
  const writeReceipts = Effect.fn("AntigravityProviderStore.writeReceipts")(function* (
    update: (receipts: ReadonlyArray<Receipt>) => ReadonlyArray<Receipt>,
  ) {
    const next = update(yield* readReceipts).slice(-MAX_LISTED);
    const text = yield* encodeReceipts({ version: 1, receipts: [...next] });
    yield* fs.makeDirectory(root, { recursive: true });
    const temporary = `${receiptsFile}.tmp`;
    yield* fs.writeFileString(temporary, text);
    yield* fs.rename(temporary, receiptsFile);
  });

  const readList = Effect.fn("AntigravityProviderStore.readList")(
    function* () {
      const sequence = yield* nextInventoryReadSequence;
      const output = yield* options.run(["plugin", "list", "--json"]);
      const plugins = yield* parseAntigravityPluginList(output, yield* readReceipts);
      return { plugins, sequence };
    },
    Effect.provideService(Path.Path, path),
    Effect.mapError(() => ({ message: "Could not read Antigravity's installed plugins." })),
  );
  const list = Effect.fn("AntigravityProviderStore.list")(function* () {
    const reason = yield* options.unavailable;
    if (reason) return yield* fail(reason);
    return yield* readList();
  });

  const toEntry = (
    plugin: AntigravityCatalogPlugin,
    installed: ReadonlyArray<AntigravityInstalledPlugin> | undefined,
    unavailable: string | undefined,
  ): ProviderStoreEntry => {
    const id = entryId(plugin.name, plugin.marketplace);
    const native = installed?.find((item) => item.name === plugin.name);
    const added = native?.id === id;
    const disabledReason =
      unavailable ??
      (installed === undefined
        ? INVENTORY_UNAVAILABLE
        : added
          ? undefined
          : native
            ? `Antigravity already has a plugin named ${plugin.name} from another source. Remove it first to add this one.`
            : plugin.archive === undefined
              ? "This plugin's download is not on Google's plugin host, so Scient can't add it."
              : undefined);
    return {
      id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      displayName: plugin.displayName,
      description: plugin.description,
      kind: "antigravity",
      installed: added,
      ...(installed === undefined ? { installationStateKnown: false } : {}),
      ...(plugin.categories[0] ? { category: plugin.categories[0] } : {}),
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(plugin.publisher ? { publisher: plugin.publisher } : {}),
      ...(plugin.website ? { website: plugin.website } : {}),
      includes: added && native ? nativeIncludes(native) : [...plugin.includes],
      publisherType: plugin.publisherType,
      ...(disabledReason ? { disabledReason } : {}),
      apps: [],
    };
  };
  const nativeIncludes = (plugin: AntigravityInstalledPlugin) => [
    ...(plugin.skills.length ? ["Skills"] : []),
    ...(plugin.mcpServers.length ? ["MCP servers"] : []),
  ];
  const withIcon = Effect.fn("AntigravityProviderStore.withIcon")(function* (
    entry: ProviderStoreEntry,
    plugin: AntigravityCatalogPlugin,
  ) {
    const iconUrl =
      (yield* catalog.icon(plugin.logoUrl)) ??
      resolveBrandIcon(plugin.displayName) ??
      resolveBrandIcon(plugin.name);
    return iconUrl ? { ...entry, iconUrl } : entry;
  });

  const listing = Effect.fn("AntigravityProviderStore.listing")(function* (refresh: boolean) {
    const [read, inventory, unavailable] = yield* Effect.all(
      [catalog.read(refresh), list().pipe(Effect.option), options.unavailable],
      { concurrency: "unbounded" },
    );
    const installed = inventory._tag === "Some" ? inventory.value.plugins : undefined;
    return {
      read,
      installed,
      unavailable,
      entries: read.plugins.map((plugin) => ({
        plugin,
        entry: toEntry(plugin, installed, unavailable),
      })),
    };
  });
  const find = Effect.fn("AntigravityProviderStore.find")(function* (id: string) {
    const current = yield* listing(false);
    const item = current.entries.find((candidate) => candidate.entry.id === id);
    if (!item) return yield* fail("This plugin is no longer in the Antigravity Marketplace.");
    return { ...current, ...item };
  });

  const search = Effect.fn("AntigravityProviderStore.search")(function* (
    input: Omit<ProviderStoreSearchInput, "instanceId">,
  ) {
    const current = yield* listing(input.refresh === true);
    const terms = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matching = current.entries.filter(
      ({ plugin }) =>
        (!input.category ||
          plugin.scientCategories.some((category) => category === input.category)) &&
        terms.every((term) =>
          [
            plugin.name,
            plugin.displayName,
            plugin.description,
            plugin.publisher ?? "",
            ...plugin.keywords,
          ]
            .join(" ")
            .toLowerCase()
            .includes(term),
        ),
    );
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) return yield* fail("Invalid store cursor.");
    const limit = Math.min(input.limit ?? (input.preview ? 6 : 30), 50);
    const entries = yield* Effect.forEach(
      matching.slice(offset, offset + limit),
      ({ entry, plugin }) => withIcon(entry, plugin),
      { concurrency: 8 },
    );
    const message =
      current.unavailable ?? (current.installed === undefined ? INVENTORY_UNAVAILABLE : undefined);
    return {
      entries,
      total: matching.length,
      ...(current.read.sourceFailures.length
        ? { sourceFailures: [...current.read.sourceFailures] }
        : {}),
      ...(offset + limit < matching.length ? { nextCursor: String(offset + limit) } : {}),
      ...(message ? { message } : {}),
    } satisfies ProviderStorePage;
  });

  const installedFolder = Effect.fn("AntigravityProviderStore.installedFolder")(function* (
    id: string,
  ) {
    const item = yield* find(id);
    const native = item.installed?.find((plugin) => plugin.id === id);
    if (!native) return yield* fail("Add this plugin to read its files.");
    return native.path;
  });

  const install = Effect.fn("AntigravityProviderStore.install")(function* (id: string) {
    // Read under the write permit: agy replaces a same-name folder silently, so the entry's
    // other-source check must see the listing this Add acts on.
    const item = yield* find(id);
    if (item.entry.disabledReason) return yield* fail(item.entry.disabledReason);
    if (item.entry.installed) return;
    const archive = item.plugin.archive;
    if (!archive) return yield* fail("This plugin cannot be added from Scient.");
    yield* Effect.scoped(
      stageAntigravityPlugin({
        name: item.plugin.name,
        version: item.plugin.version,
        archive,
        stagingRoot,
      }).pipe(
        Effect.mapError((cause) =>
          isAntigravityPluginArchiveError(cause)
            ? { message: cause.message }
            : { message: "Scient could not prepare this plugin to add." },
        ),
        Effect.flatMap((directory) => options.run(["plugin", "install", directory])),
      ),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const after = yield* list();
    const listed = after.plugins.find((plugin) => plugin.name === item.plugin.name);
    if (!listed) return yield* fail("Antigravity did not list the plugin after adding it.");
    yield* writeReceipts((receipts) => [
      ...receipts.filter((receipt) => receipt.name !== listed.name),
      {
        name: listed.name,
        marketplace: item.plugin.marketplace,
        ...((listed.version ?? item.plugin.version)
          ? { version: listed.version ?? item.plugin.version }
          : {}),
        sha256: archive.sha256,
        path: listed.path,
        displayName: item.plugin.displayName,
      },
    ]).pipe(
      Effect.mapError(() => ({
        message: "The plugin was added, but Scient could not record where it came from.",
      })),
    );
  });

  const nativePlugin = Effect.fn("AntigravityProviderStore.nativePlugin")(function* (
    pluginId: string,
  ) {
    const plugin = (yield* list()).plugins.find((item) => item.id === pluginId);
    if (!plugin?.canUninstall) return yield* fail("This plugin is no longer installed.");
    return plugin;
  });

  const publish = Effect.fn("AntigravityProviderStore.publish")(function* () {
    const listing = yield* list();
    yield* PubSub.publish(reports, { plugins: listing.plugins, sequence: listing.sequence });
  });

  const actions: ProviderPluginActions = {
    store: {
      search,
      entry: (id) => find(id).pipe(Effect.flatMap(({ entry, plugin }) => withIcon(entry, plugin))),
      install: (id) => writes.withPermits(1)(install(id)),
      contents: (id) =>
        find(id).pipe(
          Effect.flatMap(({ entry, plugin, installed }) => {
            const native = entry.installed
              ? installed?.find((item) => item.id === entry.id)
              : undefined;
            return native
              ? tryLocalPluginRead(() => readLocalPluginContents(native.path)).pipe(
                  Effect.mapError(() => ({ message: "Could not read this plugin's contents." })),
                )
              : Effect.succeed(declaredContents(plugin));
          }),
        ),
      skillDocument: (id, skillId) =>
        installedFolder(id).pipe(
          Effect.flatMap((folder) =>
            tryLocalPluginRead(() => readLocalPluginSkill(folder, skillId)).pipe(
              Effect.mapError(() => ({ message: "Could not read this skill document." })),
            ),
          ),
        ),
    },
    refreshInventory: ({ force }) =>
      (force ? catalog.invalidate : Effect.void).pipe(Effect.andThen(publish())),
    listPlugins: () => list(),
    listPluginRoots: () =>
      list().pipe(
        Effect.map((listing) =>
          listing.plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            enabled: plugin.enabled,
            root: plugin.path,
          })),
        ),
      ),
    readMcpServer: () => Effect.undefined,
    setEnabled: (input) =>
      writes.withPermits(1)(
        nativePlugin(input.pluginId).pipe(
          Effect.flatMap((plugin) =>
            options.run(["plugin", input.enabled ? "enable" : "disable", plugin.name]),
          ),
          Effect.asVoid,
        ),
      ),
    uninstall: (input) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const plugin = yield* nativePlugin(input.pluginId);
          yield* options.run(["plugin", "uninstall", plugin.name]);
          yield* writeReceipts((receipts) =>
            receipts.filter((receipt) => receipt.name !== plugin.name),
          ).pipe(Effect.ignore);
        }),
      ),
    startMcpSignIn: () =>
      fail("Sign in to this plugin's service from an Antigravity chat when it asks."),
    isRetired: Deferred.isDone(retired),
    whenRetired: Deferred.await(retired),
  };
  return { actions, reports: Stream.fromPubSub(reports) };
});

/** What `agy plugin` needs to find the OS user's home, and nothing of the chat or its secrets. */
const COMMAND_ENVIRONMENT_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

export function antigravityPluginCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENVIRONMENT_KEYS) if (env[key] !== undefined) picked[key] = env[key];
  return picked;
}

/** The plugin seam for one Antigravity instance, run through the same `agy` its chats use. */
export const makeAntigravityInstancePlugins = Effect.fn("makeAntigravityInstancePlugins")(
  function* (input: {
    readonly installation: {
      readonly resolve: (
        binaryPath?: string,
        environment?: NodeJS.ProcessEnv,
      ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
      readonly acquire: (
        binaryPath?: string,
        environment?: NodeJS.ProcessEnv,
      ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
    };
    readonly binaryPath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly stateDir: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = antigravityPluginCommandEnvironment(input.environment);
    yield* fs.makeDirectory(input.stateDir, { recursive: true }).pipe(Effect.ignore);
    const run = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const executable = yield* input.installation
            .acquire(input.binaryPath, input.environment)
            .pipe(Effect.mapError(() => ({ message: "Antigravity is not installed." })));
          if (executable.harnessPath !== null) return yield* fail(ANTIGRAVITY_NOT_CLI);
          return yield* runProviderPluginCommand(
            executable.executablePath,
            environment,
            input.stateDir,
            args,
          );
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const unavailable = input.installation.resolve(input.binaryPath, input.environment).pipe(
      Effect.map((executable) =>
        executable.harnessPath === null ? undefined : ANTIGRAVITY_NOT_CLI,
      ),
      Effect.orElseSucceed(() => "Install Antigravity to add its plugins."),
    );
    return yield* makeAntigravityPluginActions({ stateDir: input.stateDir, run, unavailable });
  },
);
