import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ConnectorAddInput,
  ConnectorAddResult,
  ConnectorRemoveInput,
  ConnectorStartSignInInput,
  ConnectorStartSignInResult,
  ConnectorTestInput,
  ConnectorTestResult,
  ConnectorUpdateInput,
  DiscoverCatalog,
  DiscoverPage,
  DiscoverSearchInput,
  ExtensionDeliveryReceiptInput,
  ExtensionDeliveryReceiptResult,
  ExtensionsChangedEvent,
  ExtensionsError,
  ExtensionsInventory,
  ExtensionsListInput,
  ProviderPluginActionInput,
  ProviderPluginActionResult,
  ScientPluginInstallInput,
  ScientPluginRemoveInput,
  ScientPluginSetEnabledInput,
} from "./extensions.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_EXTENSION_WS_METHODS = {
  extensionsList: "extensions.list",
  extensionsSubscribeChanges: "extensions.subscribeChanges",
  extensionsConnectorAdd: "extensions.connectors.add",
  extensionsConnectorStartSignIn: "extensions.connectors.startSignIn",
  extensionsConnectorUpdate: "extensions.connectors.update",
  extensionsConnectorRemove: "extensions.connectors.remove",
  extensionsConnectorTest: "extensions.connectors.test",
  extensionsDiscoverSearch: "extensions.discover.search",
  extensionsDiscoverCatalog: "extensions.discover.catalog",
  extensionsPluginInstall: "extensions.plugins.install",
  extensionsPluginRemove: "extensions.plugins.remove",
  extensionsPluginSetEnabled: "extensions.plugins.setEnabled",
  extensionsDeliveryReceipt: "extensions.deliveryReceipt",
  providerPluginsAct: "providerPlugins.act",
} as const;

const ExtensionsRpcError = Schema.Union([ExtensionsError, EnvironmentAuthorizationError]);

export const WsExtensionsListRpc = Rpc.make(SCIENT_EXTENSION_WS_METHODS.extensionsList, {
  payload: ExtensionsListInput,
  success: ExtensionsInventory,
  error: ExtensionsRpcError,
});

export const WsExtensionsDiscoverCatalogRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsDiscoverCatalog,
  { payload: Schema.Struct({}), success: DiscoverCatalog, error: ExtensionsRpcError },
);

export const WsExtensionsSubscribeChangesRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsSubscribeChanges,
  {
    payload: Schema.Struct({}),
    success: ExtensionsChangedEvent,
    error: ExtensionsRpcError,
    stream: true,
  },
);

export const WsExtensionsConnectorAddRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsConnectorAdd,
  { payload: ConnectorAddInput, success: ConnectorAddResult, error: ExtensionsRpcError },
);

export const WsExtensionsConnectorStartSignInRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsConnectorStartSignIn,
  {
    payload: ConnectorStartSignInInput,
    success: ConnectorStartSignInResult,
    error: ExtensionsRpcError,
  },
);

export const WsExtensionsConnectorUpdateRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsConnectorUpdate,
  { payload: ConnectorUpdateInput, success: ExtensionsInventory, error: ExtensionsRpcError },
);

export const WsExtensionsConnectorRemoveRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsConnectorRemove,
  { payload: ConnectorRemoveInput, success: ExtensionsInventory, error: ExtensionsRpcError },
);

export const WsExtensionsConnectorTestRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsConnectorTest,
  { payload: ConnectorTestInput, success: ConnectorTestResult, error: ExtensionsRpcError },
);

export const WsExtensionsDiscoverSearchRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsDiscoverSearch,
  { payload: DiscoverSearchInput, success: DiscoverPage, error: ExtensionsRpcError },
);

export const WsExtensionsPluginInstallRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginInstall,
  { payload: ScientPluginInstallInput, success: ExtensionsInventory, error: ExtensionsRpcError },
);

export const WsExtensionsPluginRemoveRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginRemove,
  { payload: ScientPluginRemoveInput, success: ExtensionsInventory, error: ExtensionsRpcError },
);

export const WsExtensionsPluginSetEnabledRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginSetEnabled,
  {
    payload: ScientPluginSetEnabledInput,
    success: ExtensionsInventory,
    error: ExtensionsRpcError,
  },
);

export const WsExtensionsDeliveryReceiptRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsDeliveryReceipt,
  {
    payload: ExtensionDeliveryReceiptInput,
    success: ExtensionDeliveryReceiptResult,
    error: ExtensionsRpcError,
  },
);

export const WsProviderPluginsActRpc = Rpc.make(SCIENT_EXTENSION_WS_METHODS.providerPluginsAct, {
  payload: ProviderPluginActionInput,
  success: ProviderPluginActionResult,
  error: ExtensionsRpcError,
});
