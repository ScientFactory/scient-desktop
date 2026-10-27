/**
 * Mutations belong to each extensions owner; re-read the inventory projection after dispatch rather
 * than predicting its resulting state.
 */
import {
  ExtensionsError,
  type ExtensionsChangedEvent,
  type ExtensionsInventory,
  type ServerProviders,
  WS_METHODS,
  WsExtensionsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderRegistry, type ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
import { resolveBrandIcon } from "./BrandIcons.ts";
import { makePluginContents } from "./PluginContents.ts";
import { connectorProviderSupport } from "./ConnectorProviderSupport.ts";
import {
  ConnectorRuntime,
  type ConnectorRuntimeShape,
  ExtensionDeliveryReceipts,
  type ExtensionDeliveryReceiptsShape,
  type ExtensionsDiscoverShape,
  type ProviderPluginManagementShape,
  ScientPluginRegistry,
  type ScientPluginRegistryShape,
} from "./ExtensionsServices.ts";

/**
 * Use one revision across extension owners and compatibility-changing provider updates.
 * Health/status refreshes alone must not invalidate the inventory.
 */
export interface ExtensionsChangeFeedShape {
  readonly notify: Effect.Effect<void>;
  readonly current: Effect.Effect<number>;
  readonly changes: Stream.Stream<ExtensionsChangedEvent>;
}

export class ExtensionsChangeFeed extends Context.Service<
  ExtensionsChangeFeed,
  ExtensionsChangeFeedShape
>()("t3/scient/extensions/ExtensionsRpcHandlers/ExtensionsChangeFeed") {}

/** The compatibility projection of a provider snapshot, as compared between snapshots. */
const providerSupportKey = (providers: ServerProviders): string =>
  JSON.stringify(connectorProviderSupport(providers));

/**
 * One element per provider snapshot whose connector compatibility differs from
 * the one before it (starting from `initial`).
 */
export const providerSupportChanges = (
  initial: ServerProviders,
  snapshots: Stream.Stream<ServerProviders>,
): Stream.Stream<string> =>
  Stream.concat(Stream.succeed(initial), snapshots).pipe(
    Stream.map(providerSupportKey),
    Stream.changes,
    Stream.drop(1),
  );

export const changeFeedLayer = Layer.effect(
  ExtensionsChangeFeed,
  Effect.gen(function* () {
    const connectors = yield* ConnectorRuntime;
    const plugins = yield* ScientPluginRegistry;
    const receipts = yield* ExtensionDeliveryReceipts;
    const providers = yield* ProviderRegistry;
    const revision = yield* Ref.make(0);
    const events = yield* PubSub.unbounded<ExtensionsChangedEvent>();
    const supportChanges = Stream.map(
      providerSupportChanges(yield* providers.getProviders, providers.streamChanges),
      () => undefined,
    );
    const notify = Ref.updateAndGet(revision, (value) => value + 1).pipe(
      Effect.flatMap((next) => PubSub.publish(events, { revision: next })),
      Effect.asVoid,
    );
    yield* Stream.mergeAll(
      [
        Stream.map(connectors.changes, () => undefined),
        plugins.changes,
        Stream.map(receipts.changes, () => undefined),
        supportChanges,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() => notify),
      Effect.forkScoped,
    );
    return ExtensionsChangeFeed.of({
      notify,
      current: Ref.get(revision),
      changes: Stream.fromPubSub(events),
    });
  }),
);

export const makeExtensionsRpcHandlers = ({
  observeRpcEffect,
  observeRpcStream,
  connectorRuntime,
  pluginRegistry,
  discover,
  receipts,
  providerPlugins,
  providerRegistry,
  changeFeed,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly connectorRuntime: ConnectorRuntimeShape;
  readonly pluginRegistry: ScientPluginRegistryShape;
  readonly discover: ExtensionsDiscoverShape;
  readonly receipts: ExtensionDeliveryReceiptsShape;
  readonly providerPlugins: ProviderPluginManagementShape;
  readonly providerRegistry: ProviderRegistryShape;
  readonly changeFeed: ExtensionsChangeFeedShape;
}) => {
  const traceAttributes = { "rpc.aggregate": "extensions" } as const;
  const inventory = Effect.fn("ExtensionsRpc.inventory")(function* () {
    const [connectors, plugins, providers, revision] = yield* Effect.all([
      connectorRuntime.list(),
      pluginRegistry.list(),
      providerRegistry.getProviders,
      changeFeed.current,
    ]);
    // Logos come only from the curated icon cache; a cold icon never delays the list.
    const icons = yield* discover.connectorIcons(
      connectors.connectors.map((connector) => connector.url),
    );
    return {
      revision,
      connectors: connectors.connectors.map((connector) => {
        const iconUrl = icons.get(connector.url);
        return iconUrl === undefined ? connector : { ...connector, iconUrl };
      }),
      providerSupport: connectorProviderSupport(providers),
      plugins: plugins.plugins,
      diagnostics: [...connectors.diagnostics, ...plugins.diagnostics],
    } satisfies ExtensionsInventory;
  });

  const contents = makePluginContents(providerRegistry, pluginRegistry);
  return WsExtensionsRpcGroup.of({
    [WS_METHODS.extensionsBrandIcon]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsBrandIcon,
        Effect.sync(() => ({
          icons: Object.fromEntries(
            input.names.flatMap((name) => {
              const icon = resolveBrandIcon(name);
              return icon === undefined ? [] : [[name, icon]];
            }),
          ),
        })),
        traceAttributes,
      ),
    [WS_METHODS.extensionsPluginContents]: (input) =>
      observeRpcEffect(WS_METHODS.extensionsPluginContents, contents.read(input), traceAttributes),
    [WS_METHODS.extensionsSkillDocument]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsSkillDocument,
        contents.document(input),
        traceAttributes,
      ),
    [WS_METHODS.extensionsList]: () =>
      observeRpcEffect(WS_METHODS.extensionsList, inventory(), traceAttributes),
    [WS_METHODS.extensionsSubscribeChanges]: () =>
      observeRpcStream(
        WS_METHODS.extensionsSubscribeChanges,
        Stream.unwrap(
          Effect.gen(function* () {
            for (const provider of yield* providerRegistry.getProviders) {
              if (!provider.enabled) continue;
              const actions = yield* providerRegistry.getProviderPluginActionsForInstance(
                provider.instanceId,
              );
              if (actions?.store?.changes)
                yield* actions.store.changes.pipe(
                  Stream.runForEach(() => changeFeed.notify),
                  Effect.forkScoped,
                );
              if (actions?.refreshInventory)
                yield* actions.refreshInventory({ force: false }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.forkScoped,
                );
            }
            return changeFeed.changes;
          }),
        ),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorAdd]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorAdd,
        connectorRuntime.add(input),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorStartSignIn]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorStartSignIn,
        connectorRuntime.startSignIn(input),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorUpdate]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorUpdate,
        connectorRuntime.update(input).pipe(Effect.andThen(inventory())),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorRemove,
        connectorRuntime.remove(input).pipe(Effect.andThen(inventory())),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorTest]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorTest,
        connectorRuntime.test(input),
        traceAttributes,
      ),
    [WS_METHODS.extensionsDiscoverSearch]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsDiscoverSearch,
        discover.search(input),
        traceAttributes,
      ),
    [WS_METHODS.extensionsDiscoverCatalog]: () =>
      observeRpcEffect(WS_METHODS.extensionsDiscoverCatalog, discover.catalog(), traceAttributes),
    [WS_METHODS.extensionsProviderStoreSearch]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsProviderStoreSearch,
        Effect.gen(function* () {
          const actions = yield* providerRegistry.getProviderPluginActionsForInstance(
            input.instanceId,
          );
          if (!actions?.store || (yield* actions.isRetired))
            return yield* new ExtensionsError({
              reason: "unsupported",
              message: "This agent has no available plugin store.",
            });
          return yield* actions.store.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ExtensionsError({
                  reason: "state-unavailable",
                  message: cause.message,
                }),
            ),
          );
        }),
        traceAttributes,
      ),
    [WS_METHODS.extensionsProviderStoreEntry]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsProviderStoreEntry,
        Effect.gen(function* () {
          const actions = yield* providerRegistry.getProviderPluginActionsForInstance(
            input.instanceId,
          );
          if (!actions?.store || (yield* actions.isRetired))
            return yield* new ExtensionsError({
              reason: "unsupported",
              message: "This agent has no available plugin store.",
            });
          return yield* actions.store.entry(input.entryId).pipe(
            Effect.mapError(
              () =>
                new ExtensionsError({
                  reason: "not-found",
                  message: "This plugin is no longer available.",
                }),
            ),
          );
        }),
        traceAttributes,
      ),
    [WS_METHODS.extensionsDiscoverEntry]: (input) =>
      observeRpcEffect(WS_METHODS.extensionsDiscoverEntry, discover.entry(input), traceAttributes),
    [WS_METHODS.extensionsPluginInstall]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginInstall,
        pluginRegistry.install(input).pipe(Effect.andThen(inventory())),
        traceAttributes,
      ),
    [WS_METHODS.extensionsPluginRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginRemove,
        pluginRegistry.remove(input).pipe(Effect.andThen(inventory())),
        traceAttributes,
      ),
    [WS_METHODS.extensionsPluginSetEnabled]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginSetEnabled,
        pluginRegistry.setEnabled(input).pipe(Effect.andThen(inventory())),
        traceAttributes,
      ),
    [WS_METHODS.extensionsDeliveryReceipt]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsDeliveryReceipt,
        receipts
          .get(input.threadId)
          .pipe(
            Effect.map((receipt) => (Option.isSome(receipt) ? { receipt: receipt.value } : {})),
          ),
        traceAttributes,
      ),
    [WS_METHODS.providerPluginsAct]: (input) =>
      observeRpcEffect(WS_METHODS.providerPluginsAct, providerPlugins.act(input), traceAttributes),
  });
};
