/**
 * Codex-native plugins and MCP servers, read and changed through the Codex
 * app-server. Codex owns this inventory; Scient lists it in provider snapshots
 * and dispatches the mutations Codex exposes. See
 * docs/internals/scient-extensions.md.
 */
import type {
  ServerProviderMcpServer,
  ServerProviderMcpServerStatus,
  ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { sharedPluginDisplayName } from "../scient/extensions/SharedPluginStore.ts";
import { makeCodexProviderStore } from "../scient/extensions/CodexProviderStore.ts";
import { nextInventoryReadSequence, nonEmptyText, uniqueBy } from "./ProviderNativeInventory.ts";
import type {
  ProviderMcpSignInAttempt,
  ProviderNativeInventory,
  ProviderPluginActionFailure,
  ProviderPluginActions,
  ProviderWorkspaceInventory,
} from "./ScientProviderInstanceSeams.ts";

type CodexAppServerClient = CodexClient.CodexAppServerClient["Service"];
type CodexMcpServerStatus = CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus;

/** Inventory enrichment runs off the probe's and the workspace scan's path. */
const CODEX_INVENTORY_ENRICHMENT_TIMEOUT = Duration.seconds(20);
const CODEX_MCP_SERVER_PAGE_LIMIT = 100;
/** Bounds starting the app-server and one mutation request. */
const CODEX_ACTION_TIMEOUT = Duration.seconds(30);
/** Workspace plugin listings that may run at once per instance, each with its own app-server. */
export const CODEX_WORKSPACE_LISTING_CONCURRENCY = 2;
/** Bounds a misbehaving cursor; 1000 configured servers is far past any real setup. */
const CODEX_MCP_SERVER_MAX_PAGES = 10;
/** How long Codex keeps its sign-in callback listener open. */
const CODEX_MCP_SIGN_IN_TIMEOUT_SECONDS = 300;
/** Codex reports a timed-out sign-in itself; this only bounds a silent app-server. */
const CODEX_MCP_SIGN_IN_WAIT = Duration.seconds(CODEX_MCP_SIGN_IN_TIMEOUT_SECONDS + 30);

const CODEX_PLUGIN_SOURCE: Readonly<
  Record<
    CodexSchema.V2PluginInstalledResponse__PluginSource["type"],
    ServerProviderPlugin["source"]
  >
> = {
  local: "local",
  remote: "remote",
  git: "remote",
  npm: "remote",
};

/** Plugin sources `plugin/uninstall` removes; git and npm installs are managed outside it. */
const CODEX_UNINSTALLABLE_PLUGIN_SOURCES: Readonly<Record<string, true>> = {
  local: true,
  remote: true,
};

const CODEX_MCP_RUNTIME_STATUS: Readonly<
  Record<
    CodexSchema.V2ListMcpServerStatusResponse__McpServerConnectionStatus,
    ServerProviderMcpServerStatus
  >
> = {
  notStarted: "pending",
  starting: "pending",
  connected: "connected",
  authenticationRequired: "needs-auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
};

/** Installed plugins from a `plugin/installed` response, across every marketplace that loaded. */
export function parseCodexInstalledPlugins(
  response: CodexSchema.V2PluginInstalledResponse,
): ReadonlyArray<ServerProviderPlugin> {
  return uniqueBy(
    response.marketplaces.flatMap((marketplace) => {
      const marketplaceName =
        nonEmptyText(marketplace.interface?.displayName) ?? nonEmptyText(marketplace.name);
      return marketplace.plugins.flatMap((plugin): ReadonlyArray<ServerProviderPlugin> => {
        const id = nonEmptyText(plugin.id);
        const name = nonEmptyText(plugin.name);
        if (!plugin.installed || !id || !name) return [];
        const displayName =
          nonEmptyText(plugin.interface?.displayName) ?? sharedPluginDisplayName(name);
        const description =
          nonEmptyText(plugin.interface?.shortDescription) ??
          nonEmptyText(plugin.interface?.longDescription);
        const version = nonEmptyText(plugin.localVersion) ?? nonEmptyText(plugin.version);
        return [
          {
            id,
            name,
            ...(displayName && { displayName }),
            ...(description && { description }),
            ...(version && { version }),
            ...(marketplaceName && { marketplace: marketplaceName }),
            source: CODEX_PLUGIN_SOURCE[plugin.source.type],
            enabled: plugin.enabled,
            // Default-installed and admin-disabled plugins are managed outside the user's choice.
            canUninstall:
              CODEX_UNINSTALLABLE_PLUGIN_SOURCES[plugin.source.type] === true &&
              plugin.installPolicy === "AVAILABLE" &&
              plugin.availability !== "DISABLED_BY_ADMIN",
          },
        ];
      });
    }),
    (plugin) => plugin.id,
  );
}

function codexMcpServerStatus(server: CodexMcpServerStatus): ServerProviderMcpServerStatus {
  if (server.authStatus === "notLoggedIn") return "needs-auth";
  if (server.runtimeStatus) return CODEX_MCP_RUNTIME_STATUS[server.runtimeStatus];
  // Outside a thread Codex reports no runtime state; listing tools proves the server answered.
  if (nonEmptyText(server.toolsError)) return "failed";
  return Object.keys(server.tools).length > 0 ? "connected" : "unknown";
}

/** MCP servers from `mcpServerStatus/list` pages. */
export function parseCodexMcpServers(
  statuses: ReadonlyArray<CodexMcpServerStatus>,
): ReadonlyArray<ServerProviderMcpServer> {
  return uniqueBy(
    statuses.flatMap((server): ReadonlyArray<ServerProviderMcpServer> => {
      const name = nonEmptyText(server.name);
      if (!name) return [];
      const status = codexMcpServerStatus(server);
      const pluginId = nonEmptyText(server.pluginId);
      const error = nonEmptyText(server.toolsError);
      const toolCount = Object.keys(server.tools).length;
      // Bearer-token and unsupported servers are not signed in through Codex's OAuth flow.
      const canStartSignIn =
        status === "needs-auth" &&
        server.authStatus !== "bearerToken" &&
        server.authStatus !== "unsupported";
      return [
        {
          name,
          status,
          ...(pluginId && { pluginId }),
          ...(toolCount > 0 && { toolCount }),
          ...(error && { error }),
          ...(canStartSignIn && { canStartSignIn }),
        },
      ];
    }),
    (server) => server.name,
  );
}

/**
 * A listing Codex answered only in part. Treated like a failed listing, so
 * a subset never replaces the last complete inventory.
 */
export class CodexInventoryIncomplete extends Data.TaggedError("CodexInventoryIncomplete")<{
  readonly message: string;
}> {}

/** `plugin/installed`; omit `cwds` for the plugins every workspace sees. */
export const requestCodexInstalledPlugins = Effect.fn("requestCodexInstalledPlugins")(function* (
  client: CodexAppServerClient,
  cwds?: ReadonlyArray<string>,
) {
  const response = yield* client.request("plugin/installed", cwds ? { cwds } : {});
  const loadErrors = response.marketplaceLoadErrors ?? [];
  if (loadErrors.length > 0) {
    return yield* new CodexInventoryIncomplete({
      message: `Codex could not load ${loadErrors.length === 1 ? "a plugin marketplace" : `${loadErrors.length} plugin marketplaces`}: ${loadErrors.map((failure) => `${failure.marketplacePath} (${failure.message})`).join("; ")}`,
    });
  }
  return parseCodexInstalledPlugins(response);
});

/** `mcpServerStatus/list`, every page; `serverName` asks for one server. */
export const requestCodexMcpServers = Effect.fn("requestCodexMcpServers")(function* (
  client: CodexAppServerClient,
  serverName?: string,
) {
  const statuses: CodexMcpServerStatus[] = [];
  let cursor: string | null | undefined = undefined;
  let pages = 0;
  do {
    const response: CodexSchema.V2ListMcpServerStatusResponse = yield* client.request(
      "mcpServerStatus/list",
      {
        detail: "toolsAndAuthOnly",
        limit: CODEX_MCP_SERVER_PAGE_LIMIT,
        ...(serverName === undefined ? {} : { serverName }),
        ...(cursor ? { cursor } : {}),
      },
    );
    statuses.push(...response.data);
    cursor = response.nextCursor;
    pages += 1;
  } while (cursor && pages < CODEX_MCP_SERVER_MAX_PAGES);
  if (cursor) {
    return yield* new CodexInventoryIncomplete({
      message: `Codex listed more than ${pages} pages of MCP servers; Scient stopped reading.`,
    });
  }
  return parseCodexMcpServers(statuses);
});

/**
 * Runs one inventory request, bounded, without letting it fail. `undefined`
 * means "not listed completely this time", which keeps the last inventory.
 */
export const optionalCodexInventory = <A, E, R>(
  label: string,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A | undefined, never, R> =>
  request.pipe(
    Effect.timeoutOption(CODEX_INVENTORY_ENRICHMENT_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logDebug(`Codex did not answer ${label} in time.`).pipe(Effect.as(undefined)),
        onSome: (value) => Effect.succeed<A | undefined>(value),
      }),
    ),
    Effect.catch((cause) =>
      Effect.logDebug(`Codex ${label} failed.`, { cause }).pipe(Effect.as(undefined)),
    ),
  );

/**
 * Starts Codex's own OAuth sign-in for one configured MCP server. Codex
 * listens for the browser callback inside the app-server process, so the
 * client's scope must stay open until `waitForCompletion` settles.
 */
const startCodexMcpSignIn = Effect.fn("startCodexMcpSignIn")(function* (
  client: CodexAppServerClient,
  serverName: string,
) {
  const completions =
    yield* Queue.unbounded<CodexSchema.V2McpServerOauthLoginCompletedNotification>();
  yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (notification) =>
    Queue.offer(completions, notification).pipe(Effect.asVoid),
  );
  const response = yield* client.request("mcpServer/oauth/login", {
    name: serverName,
    timeoutSecs: CODEX_MCP_SIGN_IN_TIMEOUT_SECONDS,
  });
  const waitForCompletion = Effect.gen(function* () {
    while (true) {
      const completed = yield* Queue.take(completions);
      if (completed.name !== serverName) continue;
      if (completed.success) return;
      return yield* Effect.fail<ProviderPluginActionFailure>({
        message:
          nonEmptyText(completed.error) ?? `Codex did not finish signing in to '${serverName}'.`,
      });
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: CODEX_MCP_SIGN_IN_WAIT,
      orElse: () =>
        Effect.fail<ProviderPluginActionFailure>({
          message: `Codex did not report the sign-in to '${serverName}' finishing in time.`,
        }),
    }),
  );
  return {
    authorizationUrl: response.authorizationUrl,
    waitForCompletion,
  } satisfies ProviderMcpSignInAttempt;
});

const listingFailure = (fallback: string) => (cause: unknown) => ({
  message: cause instanceof CodexInventoryIncomplete ? cause.message : fallback,
  cause,
});

/**
 * Inventory and action seams belong to one instance generation. Closing its scope must retire
 * actions and pending work so a replacement cannot inherit stale authority.
 */
export const makeCodexNativeInventory = Effect.fn("makeCodexNativeInventory")(function* <E>(
  open: (cwd: string | undefined) => Effect.Effect<CodexAppServerClient, E, Scope.Scope>,
  pluginCacheRoot?: string,
) {
  const reportsPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderNativeInventory>(),
    PubSub.shutdown,
  );
  /**
   * The latest report of each machine field, with that field's own read
   * order. A registry that subscribes late gets both, not only whichever
   * field happened to finish last.
   */
  const latestMachineRef = yield* Ref.make<{
    readonly plugins?: ProviderNativeInventory;
    readonly mcpServers?: ProviderNativeInventory;
  }>({});
  const publishMachine = (field: "plugins" | "mcpServers", report: ProviderNativeInventory) =>
    Ref.update(latestMachineRef, (latest) => ({ ...latest, [field]: report })).pipe(
      Effect.andThen(PubSub.publish(reportsPubSub, report)),
      Effect.asVoid,
    );
  // Subscribing before reading the latest values means none is missed; a
  // report seen twice carries the same sequence and applies once.
  const reports = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(reportsPubSub);
      const latest = yield* Ref.get(latestMachineRef);
      return Stream.concat(
        Stream.fromIterable(
          [latest.plugins, latest.mcpServers].filter((report) => report !== undefined),
        ),
        Stream.fromSubscription(subscription),
      );
    }),
  );
  const retired = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
  const instanceScope = yield* Effect.scope;

  /** Runs one bounded listing with its own app-server; failures are logged and dropped. */
  const enrichment = (
    cwd: string | undefined,
    list: (client: CodexAppServerClient) => Effect.Effect<void>,
  ) =>
    open(cwd).pipe(
      Effect.flatMap(list),
      Effect.scoped,
      Effect.timeoutOption(CODEX_ACTION_TIMEOUT),
      Effect.catch((cause) =>
        Effect.logDebug("Codex inventory enrichment could not start Codex.", { cause }),
      ),
      Effect.asVoid,
    );

  /**
   * Lists the machine inventory and publishes each field Codex listed
   * completely as soon as it has it. Runs off the health probe's path, as
   * snapshot enrichment that the next probe interrupts.
   */
  const refresh = enrichment(undefined, (client) =>
    Effect.gen(function* () {
      const sequence = yield* nextInventoryReadSequence;
      yield* Effect.all(
        [
          optionalCodexInventory("plugin listing", requestCodexInstalledPlugins(client)).pipe(
            Effect.flatMap((plugins) =>
              plugins ? publishMachine("plugins", { plugins, sequence }) : Effect.void,
            ),
          ),
          optionalCodexInventory("MCP server listing", requestCodexMcpServers(client)).pipe(
            Effect.flatMap((mcpServers) =>
              mcpServers ? publishMachine("mcpServers", { mcpServers, sequence }) : Effect.void,
            ),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  // One background listing per workspace, owned by this instance's scope. At
  // most CODEX_WORKSPACE_LISTING_CONCURRENCY run at once; the rest wait, and
  // waiting ones are cancelled like running ones.
  const workspacePermits = yield* Semaphore.make(CODEX_WORKSPACE_LISTING_CONCURRENCY);
  const workspaceListingsRef = yield* Ref.make<
    ReadonlyMap<string, { readonly token: object; readonly fiber: Fiber.Fiber<void> }>
  >(new Map());
  const workspaceLock = yield* Semaphore.make(1);
  /** The listing's own exit removes its entry, unless a newer listing replaced it. */
  const forgetWorkspaceListing = (cwd: string, token: object) =>
    Ref.update(workspaceListingsRef, (current) => {
      if (current.get(cwd)?.token !== token) return current;
      const next = new Map(current);
      next.delete(cwd);
      return next;
    });
  /**
   * Remove listing ownership and hand interruption to an instance fiber atomically; otherwise
   * cancellation can lose cleanup or let a queued app-server start. Only waiting for teardown may
   * be interrupted.
   */
  const stopWorkspaceListings = (stale: (cwd: string) => boolean) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const fibers = yield* Ref.modify(workspaceListingsRef, (listings) => {
          const next = new Map(listings);
          const picked: Array<Fiber.Fiber<void>> = [];
          for (const [cwd, listing] of listings) {
            if (!stale(cwd)) continue;
            next.delete(cwd);
            picked.push(listing.fiber);
          }
          return [picked, picked.length === 0 ? listings : next] as const;
        });
        if (fibers.length > 0) {
          yield* Fiber.interruptAll(fibers).pipe(Effect.forkIn(instanceScope));
        }
        return fibers;
      }),
    ).pipe(Effect.flatMap(Fiber.awaitAll), Effect.asVoid);
  const workspace: ProviderWorkspaceInventory = {
    cancel: (cwd) =>
      workspaceLock.withPermits(1)(stopWorkspaceListings((candidate) => candidate === cwd)),
    retain: (current) =>
      workspaceLock.withPermits(1)(
        Effect.gen(function* () {
          // Read under the lock that starts listings, so a listing started
          // for a workspace published after this read is never stopped.
          const keep = yield* current;
          yield* stopWorkspaceListings((cwd) => !keep.has(cwd));
        }),
      ),
    refresh: (cwd) =>
      workspaceLock.withPermits(1)(
        Effect.gen(function* () {
          // Waiting for the replaced listing to exit is interruptible: a
          // cancelled refresh leaves that teardown to the instance-owned
          // fiber and registers nothing.
          yield* stopWorkspaceListings((candidate) => candidate === cwd);
          // Only registering the new listing is masked, so it is always found.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const token = {};
              // The listing starts only once it is registered.
              const registered = yield* Deferred.make<void>();
              const fiber = yield* Deferred.await(registered).pipe(
                Effect.andThen(
                  workspacePermits.withPermits(1)(
                    enrichment(cwd, (client) =>
                      Effect.gen(function* () {
                        const sequence = yield* nextInventoryReadSequence;
                        const plugins = yield* optionalCodexInventory(
                          "workspace plugin listing",
                          requestCodexInstalledPlugins(client, [cwd]),
                        );
                        if (plugins) {
                          yield* PubSub.publish(reportsPubSub, { cwd, plugins, sequence });
                        }
                      }),
                    ),
                  ),
                ),
                Effect.ensuring(forgetWorkspaceListing(cwd, token)),
                Effect.interruptible,
                Effect.forkIn(instanceScope),
              );
              yield* Ref.update(workspaceListingsRef, (current) =>
                new Map(current).set(cwd, { token, fiber }),
              );
              yield* Deferred.succeed(registered, undefined);
            }),
          );
        }),
      ),
  };

  const store = yield* makeCodexProviderStore(open, undefined, pluginCacheRoot);
  const listPlugins = (cwd: string | undefined, refresh = false) =>
    open(cwd).pipe(
      Effect.flatMap((client) =>
        Effect.gen(function* () {
          const sequence = yield* nextInventoryReadSequence;
          const plugins = yield* requestCodexInstalledPlugins(
            client,
            cwd === undefined ? undefined : [cwd],
          );
          const enriched = yield* store
            .enrichInstalled(plugins, refresh)
            .pipe(Effect.orElseSucceed(() => plugins));
          return { plugins: enriched, sequence };
        }),
      ),
      Effect.timeout(CODEX_ACTION_TIMEOUT),
      Effect.scoped,
      Effect.mapError(listingFailure("Codex could not list its plugins.")),
    );
  const actions: ProviderPluginActions = {
    store,
    refreshInventory: Effect.fn("CodexPluginInventory.refreshInventory")(function* ({
      force,
      connectionsOnly,
    }: {
      readonly force: boolean;
      readonly connectionsOnly?: boolean | undefined;
    }) {
      if (!connectionsOnly) yield* store.search({ refresh: force, limit: 1 });
      const listing = yield* listPlugins(undefined, force || connectionsOnly === true);
      yield* publishMachine("plugins", listing);
    }),
    listPlugins: ({ cwd }) => listPlugins(cwd),
    readMcpServer: ({ serverName }) =>
      open(undefined).pipe(
        Effect.flatMap((client) => requestCodexMcpServers(client, serverName)),
        Effect.map((servers) => servers.find((server) => server.name === serverName)),
        Effect.timeout(CODEX_ACTION_TIMEOUT),
        Effect.scoped,
        Effect.mapError(listingFailure(`Codex could not read the MCP server '${serverName}'.`)),
      ),
    uninstall: ({ pluginId, cwd }) =>
      open(cwd).pipe(
        Effect.flatMap((client) => client.request("plugin/uninstall", { pluginId })),
        Effect.timeout(CODEX_ACTION_TIMEOUT),
        Effect.scoped,
        Effect.asVoid,
        Effect.mapError((cause) => ({
          message: `Codex could not uninstall '${pluginId}'.`,
          cause,
        })),
      ),
    // The app-server stays in the caller's scope: it receives the browser callback.
    startMcpSignIn: ({ serverName }) =>
      open(undefined).pipe(
        Effect.flatMap((client) => startCodexMcpSignIn(client, serverName)),
        Effect.timeout(CODEX_ACTION_TIMEOUT),
        Effect.mapError((cause) => ({
          message: `Codex could not start signing in to '${serverName}'.`,
          cause,
        })),
      ),
    isRetired: Deferred.isDone(retired),
    whenRetired: Deferred.await(retired),
  };

  yield* store.changes.pipe(
    Stream.runForEach(() =>
      actions.refreshInventory!({ force: false, connectionsOnly: true }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  return { actions, refresh, workspace, reports };
});
