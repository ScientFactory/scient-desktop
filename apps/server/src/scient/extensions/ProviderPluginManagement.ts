/**
 * Admit, mutate, and verify through the same live instance generation. Rebuilt/disabled/removed
 * instances cannot authorize changes to successors; report provider evidence rather than predicting
 * success.
 */
import {
  ExtensionsError,
  type ProviderPluginActionInput,
  type ServerProvider,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ProviderRegistry, type ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import {
  ProviderPluginManagement,
  type ProviderPluginManagementShape,
} from "./ExtensionsServices.ts";

/**
 * Each sign-in keeps one provider process alive, from start until the
 * browser callback; this bounds starting and waiting attempts together.
 */
export const MAX_PENDING_PROVIDER_MCP_SIGN_INS = 8;

const failure = (reason: ExtensionsError["reason"], message: string) =>
  new ExtensionsError({ reason, message });

const isExtensionsError = Schema.is(ExtensionsError);

const retiredDuring = (what: string) =>
  failure("state-unavailable", `The provider changed while Scient was ${what}. Try again.`);

/** Plugins a snapshot lists where the action applies: the workspace when `cwd` is given. */
function listedPlugins(
  provider: ServerProvider,
  cwd: string | undefined,
): ReadonlyArray<ServerProviderPlugin> | undefined {
  return cwd === undefined
    ? provider.plugins
    : provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.plugins;
}

function isBrowserUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Fails as soon as the generation is retired, interrupting `effect`. */
const untilRetired = <A, E>(
  actions: ProviderPluginActions,
  what: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | ExtensionsError> =>
  Effect.raceFirst(
    effect,
    actions.whenRetired.pipe(Effect.andThen(Effect.fail(retiredDuring(what)))),
  );

interface PendingSignIn {
  readonly token: object;
  /** Whether this attempt still holds its process slot; a replacement takes it over. */
  readonly ownsSlot: Ref.Ref<boolean>;
  /** Asks the attempt's worker to stop it. */
  readonly stop: Deferred.Deferred<void>;
  /** Completes once the attempt's process has exited and its slot is settled. */
  readonly exited: Deferred.Deferred<void>;
}

type SignInOutcome = "completed" | "failed" | "superseded" | "retired";

export function makeProviderPluginManagement(
  providerRegistry: ProviderRegistryShape,
  /** Owns pending sign-ins; closing it stops them and their provider processes. */
  serviceScope: Scope.Scope,
): ProviderPluginManagementShape {
  // Uninstalling rewrites the provider's own configuration; keep each
  // write and its verifying listing together.
  const writePermit = Semaphore.makeUnsafe(1);
  const pendingSignInsRef = Ref.makeUnsafe<ReadonlyMap<string, PendingSignIn>>(new Map());
  /**
   * Provider processes sign-ins may hold, counted from before validation
   * starts one until the last one has exited.
   */
  const processSlotsRef = Ref.makeUnsafe(0);
  /** Serializes sign-ins to one server, across the whole predecessor handoff. */
  const serverLocksRef = Ref.makeUnsafe<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());

  /** The instance's snapshot and its current generation's plugin seam. */
  const admit = Effect.fn("ProviderPluginManagement.admit")(function* (
    instanceId: ProviderPluginActionInput["instanceId"],
  ) {
    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!provider) {
      return yield* failure("not-found", "This provider instance is no longer available.");
    }
    if (!provider.enabled) {
      return yield* failure(
        "unsupported",
        `Enable ${provider.displayName ?? "this provider"} to manage its plugins.`,
      );
    }
    const actions = yield* providerRegistry.getProviderPluginActionsForInstance(instanceId);
    return { provider, actions };
  });

  const uninstall = Effect.fn("ProviderPluginManagement.uninstall")(function* (
    input: ProviderPluginActionInput,
    pluginId: string,
  ) {
    const { provider, actions } = yield* admit(input.instanceId);
    const providerName = provider.displayName ?? "This provider";
    if (!listedPlugins(provider, input.cwd)?.some((candidate) => candidate.id === pluginId)) {
      return yield* failure("not-found", "This provider plugin is no longer installed.");
    }
    if (!actions) {
      return yield* failure(
        "unsupported",
        `${providerName} does not let Scient uninstall plugins.`,
      );
    }

    // Validate against the generation that will act, not the published snapshot.
    const current = yield* untilRetired(
      actions,
      "checking the plugin",
      actions.listPlugins({ cwd: input.cwd }),
    ).pipe(
      Effect.mapError((cause) =>
        isExtensionsError(cause)
          ? cause
          : failure(
              "state-unavailable",
              `Scient could not read ${providerName}'s plugins, so nothing was changed: ${cause.message}`,
            ),
      ),
    );
    const plugin = current.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) {
      return yield* failure("not-found", "This provider plugin is no longer installed.");
    }
    if (plugin.canUninstall !== true) {
      return yield* failure(
        "unsupported",
        `${providerName} does not let Scient uninstall '${plugin.name}'.`,
      );
    }
    if (yield* actions.isRetired) return yield* retiredDuring("checking the plugin");

    yield* untilRetired(
      actions,
      "uninstalling the plugin",
      actions.uninstall({ pluginId, cwd: input.cwd }),
    ).pipe(
      Effect.mapError((cause) =>
        isExtensionsError(cause)
          ? cause
          : failure(
              "provider-rejected",
              cause.message.trim() || "The provider rejected this uninstall.",
            ),
      ),
    );

    // Only a fresh, complete listing from the same generation verifies it.
    const unverified = failure(
      "state-unavailable",
      `The uninstall of '${plugin.name}' was sent to ${providerName}, but Scient could not verify it.`,
    );
    const remaining = yield* untilRetired(
      actions,
      "verifying the uninstall",
      actions.listPlugins({ cwd: input.cwd }),
    ).pipe(Effect.mapError(() => unverified));
    if (remaining.plugins.some((candidate) => candidate.id === pluginId)) {
      return yield* failure(
        "provider-rejected",
        `${providerName} still lists '${plugin.name}' after uninstalling it.`,
      );
    }
    // The listing's sequence keeps slower background reads that began
    // before it from bringing the plugin back.
    const providers = yield* providerRegistry.recordProviderNativeInventory({
      instanceId: input.instanceId,
      reportedBy: actions,
      inventory: { cwd: input.cwd, plugins: remaining.plugins, sequence: remaining.sequence },
    });
    return { providers };
  });

  const setEnabled = Effect.fn("ProviderPluginManagement.setEnabled")(function* (
    input: ProviderPluginActionInput,
    pluginId: string,
    enabled: boolean,
  ) {
    const { actions } = yield* admit(input.instanceId);
    if (!actions?.setEnabled)
      return yield* failure(
        "unsupported",
        "This agent cannot change plugin enablement from Scient.",
      );
    const current = yield* untilRetired(
      actions,
      "checking the plugin",
      actions.listPlugins({ cwd: input.cwd }),
    ).pipe(
      Effect.mapError(() => failure("state-unavailable", "Could not list the agent's plugins.")),
    );
    if (!current.plugins.some((plugin) => plugin.id === pluginId && plugin.canSetEnabled))
      return yield* failure("unsupported", "This plugin cannot be switched from Scient.");
    yield* untilRetired(
      actions,
      "changing the plugin",
      actions.setEnabled({ pluginId, enabled, cwd: input.cwd }),
    ).pipe(
      Effect.mapError(() => failure("provider-rejected", "The agent did not confirm the change.")),
    );
    const listing = yield* untilRetired(
      actions,
      "verifying the plugin",
      actions.listPlugins({ cwd: input.cwd }),
    ).pipe(
      Effect.mapError(() =>
        failure("state-unavailable", "The change was sent, but could not be verified."),
      ),
    );
    if (listing.plugins.find((plugin) => plugin.id === pluginId)?.enabled !== enabled)
      return yield* failure(
        "provider-rejected",
        "The agent still reports a different plugin state.",
      );
    return {
      providers: yield* providerRegistry.recordProviderNativeInventory({
        instanceId: input.instanceId,
        reportedBy: actions,
        inventory: { cwd: input.cwd, ...listing },
      }),
    };
  });

  const reserveProcessSlot = Ref.modify(processSlotsRef, (used) =>
    used >= MAX_PENDING_PROVIDER_MCP_SIGN_INS ? [false, used] : [true, used + 1],
  ).pipe(
    Effect.flatMap((reserved) =>
      reserved
        ? Effect.void
        : Effect.fail(
            failure(
              "limit-reached",
              "Too many provider sign-ins are running. Finish or retry one first.",
            ),
          ),
    ),
  );
  const releaseProcessSlot = Ref.update(processSlotsRef, (used) => used - 1);

  const serverLock = (key: string) =>
    Ref.modify(serverLocksRef, (locks) => {
      const existing = locks.get(key);
      if (existing) return [existing, locks] as const;
      const created = Semaphore.makeUnsafe(1);
      return [created, new Map(locks).set(key, created)] as const;
    });

  const startMcpSignIn = Effect.fn("ProviderPluginManagement.startMcpSignIn")(function* (
    input: ProviderPluginActionInput,
    serverName: string,
  ) {
    const { provider, actions } = yield* admit(input.instanceId);
    const providerName = provider.displayName ?? "This provider";
    if (!provider.mcpServers?.some((candidate) => candidate.name === serverName)) {
      return yield* failure("not-found", "This provider MCP server is no longer configured.");
    }
    if (!actions) {
      return yield* failure(
        "unsupported",
        `${providerName} cannot start a sign-in to '${serverName}' from Scient.`,
      );
    }

    const key = `${input.instanceId}\u0000${serverName}`;
    const lock = yield* serverLock(key);
    // One sign-in per server at a time, from taking a slot to the worker
    // owning the new process. Only provider calls are interruptible; an
    // interruption anywhere releases the slot and stops what was started.
    const authorizationUrl = yield* lock.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (yield* actions.isRetired) return yield* retiredDuring("starting the sign-in");
          const previous = (yield* Ref.get(pendingSignInsRef)).get(key);
          // A replacement takes over its predecessor's slot; others need a free one.
          const inherited = previous ? yield* Ref.getAndSet(previous.ownsSlot, false) : false;
          if (!inherited) yield* reserveProcessSlot;
          return yield* Effect.gen(function* () {
            if (previous) {
              // The predecessor's process exits before validation starts another.
              yield* Deferred.succeed(previous.stop, undefined);
              yield* Deferred.await(previous.exited);
            }
            const server = yield* restore(
              untilRetired(
                actions,
                "checking the MCP server",
                actions.readMcpServer({ serverName }),
              ),
            ).pipe(
              Effect.mapError((cause) =>
                isExtensionsError(cause)
                  ? cause
                  : failure(
                      "state-unavailable",
                      `Scient could not read ${providerName}'s MCP server '${serverName}': ${cause.message}`,
                    ),
              ),
            );
            if (!server) {
              return yield* failure(
                "not-found",
                "This provider MCP server is no longer configured.",
              );
            }
            if (server.canStartSignIn !== true) {
              return yield* failure(
                "unsupported",
                `${providerName} cannot start a sign-in to '${serverName}' from Scient.`,
              );
            }

            const scope = yield* Scope.fork(serviceScope, "sequential");
            const attempt = yield* restore(
              untilRetired(
                actions,
                "starting the sign-in",
                actions.startMcpSignIn({ serverName }).pipe(Scope.provide(scope)),
              ),
            ).pipe(
              Effect.mapError((cause) =>
                isExtensionsError(cause)
                  ? cause
                  : failure(
                      "provider-rejected",
                      cause.message.trim() ||
                        `The provider could not start signing in to '${serverName}'.`,
                    ),
              ),
              Effect.filterOrFail(
                ({ authorizationUrl }) => isBrowserUrl(authorizationUrl),
                () =>
                  failure("provider-rejected", "The provider returned an unusable sign-in page."),
              ),
              // This caller closes it, so the close waits for the process to exit.
              Effect.onError(() => Scope.close(scope, Exit.void)),
            );

            const pending: PendingSignIn = {
              token: {},
              ownsSlot: yield* Ref.make(true),
              stop: yield* Deferred.make<void>(),
              exited: yield* Deferred.make<void>(),
            };
            yield* Ref.update(pendingSignInsRef, (current) => new Map(current).set(key, pending));
            const outcome: Effect.Effect<SignInOutcome> = Effect.raceAll([
              attempt.waitForCompletion.pipe(
                Effect.as<SignInOutcome>("completed"),
                Effect.catch((signInFailure) =>
                  Effect.logWarning("Provider MCP sign-in did not complete.", {
                    instanceId: input.instanceId,
                    serverName,
                    message: signInFailure.message,
                  }).pipe(Effect.as<SignInOutcome>("failed")),
                ),
              ),
              Deferred.await(pending.stop).pipe(Effect.as<SignInOutcome>("superseded")),
              actions.whenRetired.pipe(Effect.as<SignInOutcome>("retired")),
            ]);
            // The worker is the attempt's only closer: its slot is released
            // once the process has exited, never before.
            const settle = Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void);
              yield* Ref.update(pendingSignInsRef, (current) => {
                if (current.get(key)?.token !== pending.token) return current;
                const next = new Map(current);
                next.delete(key);
                return next;
              });
              if (yield* Ref.getAndSet(pending.ownsSlot, false)) yield* releaseProcessSlot;
              yield* Deferred.succeed(pending.exited, undefined);
            });
            yield* outcome.pipe(
              Effect.ensuring(settle),
              // The provider stores the new credential itself; re-read its server status.
              Effect.flatMap((settled) =>
                settled === "completed" || settled === "failed"
                  ? providerRegistry.refreshInstance(input.instanceId).pipe(Effect.asVoid)
                  : Effect.void,
              ),
              Effect.forkIn(serviceScope),
            );
            return attempt.authorizationUrl;
          }).pipe(
            // Until a worker owns the slot, this request releases it.
            Effect.onError(() => releaseProcessSlot),
          );
        }),
      ),
    );

    return { authorizationUrl, providers: yield* providerRegistry.getProviders };
  });

  return {
    act: (input) => {
      switch (input.action.type) {
        case "refresh-inventory":
          return Effect.gen(function* () {
            const { actions } = yield* admit(input.instanceId);
            if (actions?.refreshInventory)
              yield* untilRetired(
                actions,
                "refreshing extensions",
                actions.refreshInventory({ force: true }),
              ).pipe(
                Effect.mapError(() =>
                  failure("state-unavailable", "Could not refresh this agent's extensions."),
                ),
              );
            return { providers: yield* providerRegistry.getProviders };
          });
        case "set-enabled":
          return writePermit.withPermits(1)(
            setEnabled(input, input.action.pluginId, input.action.enabled),
          );
        case "uninstall":
          return writePermit.withPermits(1)(uninstall(input, input.action.pluginId));
        case "mcp-sign-in":
          return startMcpSignIn(input, input.action.serverName);
      }
    },
  };
}

export const layer = Layer.effect(
  ProviderPluginManagement,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const serviceScope = yield* Effect.scope;
    return makeProviderPluginManagement(providerRegistry, serviceScope);
  }),
);
