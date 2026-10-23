/**
 * Server composition of Scient Extensions: every owner's service layer plus the
 * shared change feed. Provided to the runtime dependencies so provider session
 * preparation, the HTTP routes and the WebSocket RPCs share one instance each.
 */
import * as Layer from "effect/Layer";

import * as ConnectorCredentialStore from "./connectors/ConnectorCredentialStore.ts";
import * as ConnectorRuntime from "./connectors/ConnectorRuntime.ts";
import * as ExtensionsDiscover from "./discover/ExtensionsDiscover.ts";
import * as ExtensionDeliveryReceipts from "./ExtensionDeliveryReceipts.ts";
import { changeFeedLayer } from "./ExtensionsRpcHandlers.ts";
import * as PluginConnectorEligibility from "./plugins/PluginConnectorEligibility.ts";
import * as ScientPluginRegistry from "./plugins/ScientPluginRegistry.ts";
import * as ProviderPluginManagement from "./ProviderPluginManagement.ts";

// One eligibility instance beneath both the runtime (which checks it) and the
// plugin registry (which publishes it).
const ConnectorCoreLive = Layer.merge(
  ConnectorRuntime.layer.pipe(Layer.provide(ConnectorCredentialStore.layer)),
  ExtensionDeliveryReceipts.layer,
).pipe(Layer.provideMerge(PluginConnectorEligibility.layer));

const ExtensionOwnersLive = Layer.mergeAll(
  ScientPluginRegistry.layer,
  ExtensionsDiscover.layer,
  ProviderPluginManagement.layer,
).pipe(Layer.provideMerge(ConnectorCoreLive));

export const ScientExtensionsLayerLive = changeFeedLayer.pipe(
  Layer.provideMerge(ExtensionOwnersLive),
);
