/**
 * Server composition of Scient Extensions: every owner's service layer plus the
 * shared change feed. Provided to the runtime dependencies so provider session
 * preparation, the HTTP routes and the WebSocket RPCs share one instance each.
 */
import * as Layer from "effect/Layer";

// SCIENT-FORK:START — Scient Accounts: migrate and encrypt connector envelopes through the shared vault.
import * as AccountsConnectorCredentials from "../accounts/AccountsConnectorCredentials.ts";
import { AccountVaultLive } from "../accounts/AccountsLayers.ts";
// SCIENT-FORK:END
import * as ConnectorRuntime from "./connectors/ConnectorRuntime.ts";
import * as ExtensionsDiscover from "./discover/ExtensionsDiscover.ts";
import * as ExtensionDeliveryReceipts from "./ExtensionDeliveryReceipts.ts";
import { changeFeedLayer } from "./ExtensionsRpcHandlers.ts";
import * as PluginConnectorEligibility from "./plugins/PluginConnectorEligibility.ts";
import * as ScientPluginRegistry from "./plugins/ScientPluginRegistry.ts";
import * as PluginKeyBindings from "./PluginKeyBindings.ts";
import * as ProviderPluginManagement from "./ProviderPluginManagement.ts";

// One eligibility instance beneath both the runtime (which checks it) and the
// plugin registry (which publishes it).
const ConnectorCoreLive = Layer.merge(
  ConnectorRuntime.layer.pipe(
    Layer.provide(AccountsConnectorCredentials.layer.pipe(Layer.provide(AccountVaultLive))),
  ),
  ExtensionDeliveryReceipts.layer,
).pipe(Layer.provideMerge(PluginConnectorEligibility.layer));

const ExtensionOwnersLive = Layer.mergeAll(
  ScientPluginRegistry.layer,
  PluginKeyBindings.layer,
  ExtensionsDiscover.layer,
  ProviderPluginManagement.layer,
).pipe(Layer.provideMerge(ConnectorCoreLive));

export const ScientExtensionsLayerLive = changeFeedLayer.pipe(
  Layer.provideMerge(ExtensionOwnersLive),
);
