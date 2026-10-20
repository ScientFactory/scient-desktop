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
  type ProjectId,
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

import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ScientRpcObservers } from "../ScientRpcObservers.ts";
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
 * One monotonically increasing revision across every extensions owner:
 * connector and selection changes, Scient plugin changes and newly recorded
 * delivery receipts.
 */
export interface ExtensionsChangeFeedShape {
  readonly current: Effect.Effect<number>;
  readonly changes: Stream.Stream<ExtensionsChangedEvent>;
}

export class ExtensionsChangeFeed extends Context.Service<
  ExtensionsChangeFeed,
  ExtensionsChangeFeedShape
>()("t3/scient/extensions/ExtensionsRpcHandlers/ExtensionsChangeFeed") {}

export const changeFeedLayer = Layer.effect(
  ExtensionsChangeFeed,
  Effect.gen(function* () {
    const connectors = yield* ConnectorRuntime;
    const plugins = yield* ScientPluginRegistry;
    const receipts = yield* ExtensionDeliveryReceipts;
    const revision = yield* Ref.make(0);
    const events = yield* PubSub.unbounded<ExtensionsChangedEvent>();
    yield* Stream.mergeAll(
      [
        Stream.map(connectors.changes, () => undefined),
        plugins.changes,
        Stream.map(receipts.changes, () => undefined),
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
  const inventory = Effect.fn("ExtensionsRpc.inventory")(function* (
    projectId: ProjectId | undefined,
  ) {
    const [connectors, plugins, providers, revision] = yield* Effect.all([
      connectorRuntime.list({ projectId }),
      pluginRegistry.list(),
      providerRegistry.getProviders,
      changeFeed.current,
    ]);
    return {
      revision,
      connectors: connectors.connectors,
      projectSelections: connectors.projectSelections,
      providerSupport: connectorProviderSupport(providers),
      plugins: plugins.plugins,
      diagnostics: [...connectors.diagnostics, ...plugins.diagnostics],
    } satisfies ExtensionsInventory;
  });

  return WsExtensionsRpcGroup.of({
    [WS_METHODS.extensionsList]: (input) =>
      observeRpcEffect(WS_METHODS.extensionsList, inventory(input.projectId), traceAttributes),
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
        connectorRuntime.update(input).pipe(Effect.andThen(inventory(undefined))),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorSetProjectSelection]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorSetProjectSelection,
        connectorRuntime
          .setProjectSelection(input)
          .pipe(Effect.andThen(inventory(input.projectId))),
        traceAttributes,
      ),
    [WS_METHODS.extensionsConnectorRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsConnectorRemove,
        connectorRuntime.remove(input).pipe(Effect.andThen(inventory(undefined))),
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
    [WS_METHODS.extensionsPluginInstall]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginInstall,
        pluginRegistry.install(input).pipe(Effect.andThen(inventory(undefined))),
        traceAttributes,
      ),
    [WS_METHODS.extensionsPluginRemove]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginRemove,
        pluginRegistry.remove(input).pipe(Effect.andThen(inventory(undefined))),
        traceAttributes,
      ),
    [WS_METHODS.extensionsPluginSetEnabled]: (input) =>
      observeRpcEffect(
        WS_METHODS.extensionsPluginSetEnabled,
        pluginRegistry.setEnabled(input).pipe(Effect.andThen(inventory(undefined))),
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
