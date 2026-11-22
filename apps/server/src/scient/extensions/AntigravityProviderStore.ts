/**
 * The Antigravity Marketplace in Scient: Google's two catalogs, added to the OS user's Antigravity
 * plugins (shared with their Antigravity app) by agy's own marketplace install, or, when agy is not
 * signed in, by installing the catalog's checked archive. A receipt records an archive Add's origin,
 * which agy lists only for its own marketplace installs.
 */
import type {
  ExtensionPluginContents,
  ProviderInstallState,
  ProviderStoreEntry,
  ProviderStorePage,
  ProviderStoreSearchInput,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ChildProcessSpawner } from "effect/process";
import type {
  ProviderNativeInventory,
  ProviderPluginActions,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { nextInventoryReadSequence } from "../../provider/ProviderNativeInventory.ts";
import { resolveAntigravityUserHome } from "../../provider/Drivers/AntigravitySkills.ts";
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
  type AntigravityPluginIdentity,
} from "./AntigravityPluginCatalog.ts";
import {
  ARCHIVE_LIMITS,
  isAntigravityPluginArchiveError,
  sha256Hex,
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
  /** agy's own `source` for the installed copy, when it reported one. */
  source: Schema.optional(Schema.String),
  /** The installed folder's identity and its plugin.json digest at Add (`installationIdentity`). */
  installation: Schema.optional(Schema.String),
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
  readonly nativeSource?: string | undefined;
  /** The catalog this copy matches, recorded (agy, receipt) or only by its manifest. */
  readonly catalogMarketplace?: string | undefined;
  readonly skills: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
};

const entryId = (name: string, marketplace: string) => `${name}@${marketplace}`;

export const ANTIGRAVITY_NOT_CLI =
  "Update Antigravity in this agent's settings to add its plugins.";
export const ANTIGRAVITY_CUSTOM_NOT_CLI =
  "This agent's custom Antigravity runtime can't add plugins. Point its path at agy, or clear it in this agent's settings.";
export const ANTIGRAVITY_SYSTEM_NOT_CLI =
  "The Antigravity runtime installed on this computer can't add plugins. Choose Use Scient-managed in this agent's settings to add them.";
/** Why a runtime that is not the agy CLI can't add plugins, by where it came from. */
const notCliReason = (executable: AntigravityExecutable) =>
  executable.source === "override"
    ? ANTIGRAVITY_CUSTOM_NOT_CLI
    : executable.source === "path"
      ? ANTIGRAVITY_SYSTEM_NOT_CLI
      : ANTIGRAVITY_NOT_CLI;
const INVENTORY_UNAVAILABLE =
  "Scient could not read Antigravity's installed plugins, so Add and Remove are paused. Refresh to try again.";

/**
 * One installed copy: its folder's device, inode and birth time, and its plugin.json digest. A
 * copy replaced in Antigravity, even at the same name, version and folder, gets another identity.
 */
const installationIdentity = Effect.fn("AntigravityProviderStore.installationIdentity")(function* (
  folder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.stat(folder);
  const manifestFile = path.join(folder, "plugin.json");
  const manifestInfo = yield* fs.stat(manifestFile);
  if (
    info.type !== "Directory" ||
    manifestInfo.type !== "File" ||
    Number(manifestInfo.size) > ARCHIVE_LIMITS.manifestBytes
  )
    return yield* fail("Not a plugin folder.");
  const manifest = yield* fs.readFile(manifestFile);
  const born = Option.match(info.birthtime, { onNone: () => "", onSome: (at) => at.getTime() });
  const inode = Option.getOrElse(info.ino, () => 0n);
  return `${info.dev}:${inode}:${born}:${sha256Hex(manifest)}`;
});

/**
 * The receipt for this exact listed copy: same name, folder, version and native source, and the
 * identity recorded at Add. Anything else is a local plugin of its own.
 */
const receiptFor = Effect.fn("AntigravityProviderStore.receiptFor")(function* (
  receipts: ReadonlyArray<Receipt>,
  plugin: {
    readonly name: string;
    readonly path: string;
    readonly version?: string | undefined;
    readonly source?: string | undefined;
  },
) {
  const candidate = receipts.find(
    (receipt) =>
      receipt.name === plugin.name &&
      receipt.path === plugin.path &&
      receipt.version !== undefined &&
      receipt.version === plugin.version &&
      receipt.source === plugin.source &&
      receipt.installation !== undefined,
  );
  if (!candidate) return undefined;
  const identity = yield* installationIdentity(plugin.path).pipe(Effect.option);
  return Option.getOrUndefined(identity) === candidate.installation ? candidate : undefined;
});

const MARKETPLACE_NAMES: ReadonlySet<string> = new Set(
  ANTIGRAVITY_MARKETPLACES.map((item) => item.name),
);
const InstalledManifest = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  repository: Schema.optional(Schema.Unknown),
  author: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.Unknown),
});
const decodeInstalledManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InstalledManifest),
);
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const comparableRepository = (value: string | undefined) =>
  value
    ?.toLowerCase()
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");

/**
 * Whether a copy installed without a recorded origin is this catalog plugin: same name in its
 * plugin.json, and the same repository, author or description the catalog states for it.
 */
const manifestMatches = Effect.fn("AntigravityProviderStore.manifestMatches")(function* (
  folder: string,
  name: string,
  identity: AntigravityPluginIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(folder, "plugin.json");
  const info = yield* fs.stat(file);
  if (info.type !== "File" || Number(info.size) > ARCHIVE_LIMITS.manifestBytes) return false;
  const manifest = yield* decodeInstalledManifest(yield* fs.readFileString(file));
  if (text(manifest.name) !== name) return false;
  const author =
    typeof manifest.author === "object" && manifest.author !== null && "name" in manifest.author
      ? text(manifest.author.name)
      : text(manifest.author);
  const repository = comparableRepository(text(manifest.repository));
  return (
    (repository !== undefined && repository === comparableRepository(identity.repository)) ||
    (author !== undefined && author.toLowerCase() === identity.author?.toLowerCase()) ||
    (text(manifest.description) !== undefined &&
      text(manifest.description) === identity.description)
  );
});

/**
 * The marketplace an installed copy came from: agy's own record first, then Scient's receipt for
 * an archive Add (both `recorded`), then, for a copy installed before agy recorded origins, its
 * manifest. A manifest match only shows the copy as added; it never acts as the catalog entry.
 */
const installedMarketplace = Effect.fn("AntigravityProviderStore.installedMarketplace")(function* (
  plugin: {
    readonly name: string;
    readonly path: string;
    readonly version?: string | undefined;
    readonly source?: string | undefined;
  },
  receipts: ReadonlyArray<Receipt>,
  catalog: ReadonlyMap<string, AntigravityCatalogPlugin> | undefined,
) {
  if (plugin.source !== undefined && MARKETPLACE_NAMES.has(plugin.source))
    return { marketplace: plugin.source, recorded: true, receipt: undefined };
  const receipt = yield* receiptFor(receipts, plugin);
  if (receipt) return { marketplace: receipt.marketplace, recorded: true, receipt };
  const entry = catalog?.get(plugin.name);
  if (!entry || (plugin.source !== undefined && plugin.source !== "antigravity")) return undefined;
  const matches = yield* manifestMatches(plugin.path, plugin.name, entry.identity).pipe(
    Effect.orElseSucceed(() => false),
  );
  return matches
    ? { marketplace: entry.marketplace, recorded: false, receipt: undefined }
    : undefined;
});

/** `agy plugin list --json` as provider plugins; any malformed listing fails as a whole. */
const parseAntigravityPluginList = Effect.fn("AntigravityProviderStore.parseList")(function* (
  output: string,
  receipts: ReadonlyArray<Receipt>,
  catalog?: ReadonlyMap<string, AntigravityCatalogPlugin> | undefined,
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
    const source = item.source?.trim() || undefined;
    const origin = yield* installedMarketplace(
      { name: item.name, path: item.path, version, source },
      receipts,
      catalog,
    );
    const marketplace = origin?.recorded ? origin.marketplace : undefined;
    const listedName =
      (origin ? catalog?.get(item.name)?.displayName : undefined) ??
      origin?.receipt?.displayName?.trim();
    plugins.push({
      id: marketplace ? entryId(item.name, marketplace) : `antigravity:${item.name}`,
      name: item.name,
      displayName: listedName || sharedPluginDisplayName(item.name),
      ...(version ? { version } : {}),
      ...(marketplace ? { marketplace } : {}),
      source: "local",
      enabled: item.enabled,
      canUninstall: true,
      canSetEnabled: true,
      sourceLabel: marketplace ? "Antigravity Marketplace" : "Antigravity's plugins",
      scope: "user",
      path: item.path,
      ...(source ? { nativeSource: source } : {}),
      ...(origin ? { catalogMarketplace: origin.marketplace } : {}),
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

/**
 * Each live instance's inventory refresh, by the plugin folder it shares: agy installs per OS
 * user, so one instance's change is every same-home instance's change.
 */
const instancesByPluginHome = new Map<string, Set<Effect.Effect<void>>>();
/** One write at a time per plugin folder, across every instance and its receipt file. */
const writesByPluginHome = new Map<string, Semaphore.Semaphore>();

const WORKSPACE_REFUSED =
  "Antigravity plugins belong to your user account, not a workspace. Change them from the agent's own list.";

export interface AntigravityPluginStoreOptions {
  /** Scient's state folder: receipts and the private staging folder live under it. */
  readonly stateDir: string;
  /** Runs this instance's `agy` with fixed arguments, or fails with why it cannot. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, Failure>;
  /** Why this instance cannot manage plugins (it is not the agy CLI), or `undefined`. */
  readonly unavailable: Effect.Effect<string | undefined>;
  /** Fires when the runtime behind `unavailable` may have changed: an install, update or removal. */
  readonly runtimeChanges?: Stream.Stream<unknown> | undefined;
  /** The resolved plugin folder agy writes, shared by every instance with the same home. */
  readonly pluginHome?: string | undefined;
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
  const writes =
    options.pluginHome === undefined
      ? yield* Semaphore.make(1)
      : (writesByPluginHome.get(options.pluginHome) ??
        (yield* Semaphore.make(1).pipe(
          Effect.tap((created) =>
            Effect.sync(() => writesByPluginHome.set(options.pluginHome!, created)),
          ),
        )));

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
      // The cached catalog, when it reads, names plugins installed before agy recorded origins.
      // Read before agy's list, so a slow catalog never makes the listing stale.
      const known = yield* catalog.read(false).pipe(
        Effect.map((read) => new Map(read.plugins.map((plugin) => [plugin.name, plugin]))),
        Effect.option,
      );
      const sequence = yield* nextInventoryReadSequence;
      const output = yield* options.run(["plugin", "list", "--json"]);
      const plugins = yield* parseAntigravityPluginList(
        output,
        yield* readReceipts,
        Option.getOrUndefined(known),
      );
      return { plugins, sequence };
    },
    Effect.provideService(Path.Path, path),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.mapError(() => ({ message: "Could not read Antigravity's installed plugins." })),
  );
  /** agy's own list and nothing else: the last check before a change acts on it. */
  const nativeListed = Effect.fn("AntigravityProviderStore.nativeListed")(
    function* () {
      return yield* decodeListed((yield* options.run(["plugin", "list", "--json"])).trim());
    },
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
    const added = native?.id === id || native?.catalogMarketplace === plugin.marketplace;
    const disabledReason =
      unavailable ??
      (installed === undefined
        ? INVENTORY_UNAVAILABLE
        : added
          ? undefined
          : native
            ? `Antigravity already has a different plugin named ${plugin.name}. Remove that one from Installed to add this one.`
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
      ...(unavailable ? { storeUnavailable: true } : {}),
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
    const name = item.plugin.name;
    const marketplace = item.plugin.marketplace;
    // agy's own marketplace install records the origin, keeps the plugin updated and refuses a
    // folder another source holds. It needs agy's own sign-in; without one, Scient adds the
    // catalog's checked archive instead.
    const named = yield* options.run(["plugin", "install", id]).pipe(Effect.option);
    const afterNamed = (yield* nativeListed()).find((plugin) => plugin.name === name);
    if (afterNamed) {
      if (afterNamed.source?.trim() !== marketplace)
        return yield* fail(
          `Antigravity has a different plugin named ${name} now, so Scient did not add this one.`,
        );
      yield* writeReceipts((receipts) =>
        receipts.filter((receipt) => receipt.path !== afterNamed.path),
      ).pipe(Effect.ignore);
      return;
    }
    if (named._tag === "Some")
      return yield* fail("Antigravity did not list the plugin after adding it.");
    const archive = item.plugin.archive;
    if (!archive) return yield* fail("This plugin cannot be added from Scient.");
    const added = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* stageAntigravityPlugin({
          name,
          version: item.plugin.version,
          archive,
          stagingRoot,
        }).pipe(
          Effect.mapError((cause) =>
            isAntigravityPluginArchiveError(cause)
              ? { message: cause.message }
              : { message: "Scient could not prepare this plugin to add." },
          ),
        );
        const staged = sha256Hex(
          yield* fs
            .readFile(path.join(directory, "plugin.json"))
            .pipe(
              Effect.mapError(() => ({ message: "Scient could not read the prepared plugin." })),
            ),
        );
        // A directory install replaces a same-name folder, so agy's own list is the last read
        // before it: nothing else may run between them.
        if ((yield* nativeListed()).some((plugin) => plugin.name === name))
          return yield* fail(
            `Antigravity got a plugin named ${name} while Scient was preparing this one, so Scient did not replace it.`,
          );
        const startedAt = yield* Clock.currentTimeMillis;
        yield* options.run(["plugin", "install", directory]);
        return { staged, startedAt };
      }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const listed = (yield* nativeListed()).find((plugin) => plugin.name === name);
    if (!listed) return yield* fail("Antigravity did not list the plugin after adding it.");
    const installation = yield* installationIdentity(listed.path).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => ({
        message: "The plugin was added, but Scient could not read its installed folder.",
      })),
    );
    // The receipt vouches only for the copy this Add installed, never one swapped in after: the
    // folder agy created (born after the install began, where the system records births) with
    // the staged plugin.json.
    const born = installation.split(":")[2];
    if (
      !installation.endsWith(`:${added.staged}`) ||
      (born !== undefined && born !== "" && Number(born) < added.startedAt - 2_000)
    )
      return yield* fail(
        `The plugin named ${name} changed while Scient added it, so Scient did not claim it.`,
      );
    const version = listed.version?.trim() || undefined;
    const source = listed.source?.trim() || undefined;
    yield* writeReceipts((receipts) => [
      // Receipts are per installed folder: another plugin home's receipt for the name stays.
      ...receipts.filter((receipt) => receipt.path !== listed.path),
      {
        name,
        marketplace,
        ...(version ? { version } : {}),
        ...(source ? { source } : {}),
        sha256: archive.sha256,
        path: listed.path,
        displayName: item.plugin.displayName,
        installation,
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
  const refreshThis = Effect.suspend(() => publish()).pipe(Effect.ignore);
  // Open pages refetch, and the agent's list is read again, once the runtime can (or no longer
  // can) add plugins.
  const runtimeChanged = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  if (options.runtimeChanges !== undefined)
    yield* Stream.concat(
      Stream.fromEffect(options.unavailable),
      options.runtimeChanges.pipe(Stream.mapEffect(() => options.unavailable)),
    ).pipe(
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(() =>
        PubSub.publish(runtimeChanged, undefined).pipe(Effect.andThen(refreshThis)),
      ),
      Effect.forkScoped,
    );
  const home = options.pluginHome;
  if (home !== undefined) {
    const peers = instancesByPluginHome.get(home) ?? new Set();
    peers.add(refreshThis);
    instancesByPluginHome.set(home, peers);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        peers.delete(refreshThis);
        if (peers.size === 0 && instancesByPluginHome.get(home) === peers)
          instancesByPluginHome.delete(home);
      }),
    );
  }
  /** After a change, every instance sharing this plugin folder publishes its verified list. */
  const announce = Effect.suspend(() =>
    Effect.forEach(
      home === undefined ? [refreshThis] : [...(instancesByPluginHome.get(home) ?? [refreshThis])],
      (refresh) => refresh,
      { concurrency: "unbounded", discard: true },
    ),
  );
  const changeAll = <A, E>(change: Effect.Effect<A, E>) =>
    writes.withPermits(1)(change.pipe(Effect.ensuring(announce)));

  const actions: ProviderPluginActions = {
    store: {
      search,
      changes: Stream.fromPubSub(runtimeChanged),
      entry: (id) => find(id).pipe(Effect.flatMap(({ entry, plugin }) => withIcon(entry, plugin))),
      install: (id) => changeAll(install(id)),
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
      input.cwd !== undefined
        ? fail(WORKSPACE_REFUSED)
        : changeAll(
            nativePlugin(input.pluginId).pipe(
              Effect.flatMap((plugin) =>
                options.run(["plugin", input.enabled ? "enable" : "disable", plugin.name]),
              ),
              Effect.asVoid,
            ),
          ),
    uninstall: (input) =>
      input.cwd !== undefined
        ? fail(WORKSPACE_REFUSED)
        : changeAll(
            Effect.gen(function* () {
              const plugin = yield* nativePlugin(input.pluginId);
              yield* options.run(["plugin", "uninstall", plugin.name]);
              yield* writeReceipts((receipts) =>
                receipts.filter((receipt) => receipt.path !== plugin.path),
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
      readonly changes: Stream.Stream<ProviderInstallState>;
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
          if (executable.harnessPath !== null) return yield* fail(notCliReason(executable));
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
        executable.harnessPath === null ? undefined : notCliReason(executable),
      ),
      Effect.orElseSucceed(() => "Install Antigravity to add its plugins."),
    );
    // The same home agy and the chat runtime resolve, so every instance writing one plugin
    // folder shares its lock; Windows paths compare case-insensitively.
    const platform = yield* HostProcess.Platform;
    const home = resolveAntigravityUserHome(
      platform,
      input.environment,
      yield* HostProcess.HomeDirectory,
    );
    const pluginHome = path.resolve(home, ".gemini", "config", "plugins");
    return yield* makeAntigravityPluginActions({
      stateDir: input.stateDir,
      run,
      unavailable,
      // Activation and removal settle here; progress in between changes nothing yet.
      runtimeChanges: input.installation.changes.pipe(
        Stream.filter((state) => state.phase === "succeeded" || state.phase === "idle"),
      ),
      pluginHome: platform === "win32" ? pluginHome.toLowerCase() : pluginHome,
    });
  },
);
