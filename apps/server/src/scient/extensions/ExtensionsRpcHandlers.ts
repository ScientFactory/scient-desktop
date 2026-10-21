/**
 * The extensions WebSocket RPCs. The inventory is a projection: connectors from
 * ConnectorRuntime, Scient plugins from ScientPluginRegistry and provider
 * compatibility from provider snapshots. Every mutation is dispatched to its
 * owner and the inventory is re-read afterwards.
 *
 * @module ExtensionsRpcHandlers
 */
import {
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
import { connectorProviderSupport } from "./ConnectorProviderSupport.ts";
import {
  ConnectorRuntime,
  type ConnectorRuntimeShape,
  ExtensionDeliveryReceipts,
  type ExtensionDeliveryReceiptsShape,
  ExtensionsDiscover,
  type ExtensionsDiscoverShape,
  type ProviderPluginManagementShape,
  ScientPluginRegistry,
  type ScientPluginRegistryShape,
} from "./ExtensionsServices.ts";

/**
 * One monotonically increasing revision across every extensions owner:
 * connector and selection changes, Scient plugin changes, newly recorded
 * delivery receipts, and provider changes that alter connector compatibility
 * (instances added or removed, a driver or display name replaced; health and
 * status refreshes are not news).
 */
export interface ExtensionsChangeFeedShape {
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
    const discover = yield* ExtensionsDiscover;
    const revision = yield* Ref.make(0);
    const events = yield* PubSub.unbounded<ExtensionsChangedEvent>();
    const supportChanges = Stream.map(
      providerSupportChanges(yield* providers.getProviders, providers.streamChanges),
      () => undefined,
    );
    yield* Stream.mergeAll(
      [
        Stream.map(connectors.changes, () => undefined),
        plugins.changes,
        Stream.map(receipts.changes, () => undefined),
        supportChanges,
        // Curated icons that earlier responses left out are now ready.
        discover.changes,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() =>
        Ref.updateAndGet(revision, (value) => value + 1).pipe(
          Effect.flatMap((next) => PubSub.publish(events, { revision: next })),
        ),
      ),
      Effect.forkScoped,
    );
    return ExtensionsChangeFeed.of({
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

  return WsExtensionsRpcGroup.of({
    [WS_METHODS.extensionsList]: () =>
      observeRpcEffect(WS_METHODS.extensionsList, inventory(), traceAttributes),
    [WS_METHODS.extensionsSubscribeChanges]: () =>
      observeRpcStream(WS_METHODS.extensionsSubscribeChanges, changeFeed.changes, traceAttributes),
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
