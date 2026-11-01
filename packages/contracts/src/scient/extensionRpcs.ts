import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  PluginKeyTarget,
  PluginKeyState,
  PluginKeyBindInput,
  PluginKeyUnbindInput,
} from "./pluginKeys.ts";
import { ExtensionIconDataUri } from "./extensionIcon.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ExtensionPluginContentsInput,
  ExtensionPluginContents,
  ExtensionSkillDocumentInput,
  ExtensionSkillDocument,
  ConnectorAddInput,
  ConnectorAddResult,
  ConnectorRemoveInput,
  ConnectorStartSignInInput,
  ConnectorStartSignInResult,
  ConnectorTestInput,
  ConnectorTestResult,
  ConnectorUpdateInput,
  DiscoverCatalog,
  DiscoverEntry,
  DiscoverEntryInput,
  DiscoverPage,
  DiscoverSearchInput,
  ExtensionDeliveryReceiptInput,
  ExtensionDeliveryReceiptResult,
  ExtensionsChangedEvent,
  ExtensionsError,
  ExtensionsInventory,
  ExtensionsListInput,
  ProviderStoreSearchInput,
  ProviderStoreEntryInput,
  ProviderStorePage,
  ProviderStoreEntry,
  ProviderPluginActionInput,
  ProviderPluginActionResult,
  ScientPluginInstallInput,
  ScientPluginRemoveInput,
  ScientPluginSetEnabledInput,
} from "./extensions.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_EXTENSION_WS_METHODS = {
  extensionsBrandIcon: "extensions.brandIcon",
  extensionsProviderStoreSearch: "extensions.providerStore.search",
  extensionsProviderStoreEntry: "extensions.providerStore.entry",
  extensionsList: "extensions.list",
  extensionsPluginKeys: "extensions.plugins.keys",
  extensionsPluginKeyBind: "extensions.plugins.keys.bind",
  extensionsPluginKeyUnbind: "extensions.plugins.keys.unbind",
  extensionsPluginContents: "extensions.plugins.contents",
  extensionsSkillDocument: "extensions.skills.document",
  extensionsSubscribeChanges: "extensions.subscribeChanges",
  extensionsConnectorAdd: "extensions.connectors.add",
  extensionsConnectorStartSignIn: "extensions.connectors.startSignIn",
  extensionsConnectorUpdate: "extensions.connectors.update",
  extensionsConnectorRemove: "extensions.connectors.remove",
  extensionsConnectorTest: "extensions.connectors.test",
  extensionsDiscoverSearch: "extensions.discover.search",
  extensionsDiscoverCatalog: "extensions.discover.catalog",
  extensionsDiscoverEntry: "extensions.discover.entry",
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

export const WsExtensionsDiscoverEntryRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsDiscoverEntry,
  { payload: DiscoverEntryInput, success: DiscoverEntry, error: ExtensionsRpcError },
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

export const WsExtensionsProviderStoreSearchRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsProviderStoreSearch,
  { payload: ProviderStoreSearchInput, success: ProviderStorePage, error: ExtensionsRpcError },
);
export const WsExtensionsProviderStoreEntryRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsProviderStoreEntry,
  { payload: ProviderStoreEntryInput, success: ProviderStoreEntry, error: ExtensionsRpcError },
);

export const WsExtensionsBrandIconRpc = Rpc.make(SCIENT_EXTENSION_WS_METHODS.extensionsBrandIcon, {
  payload: Schema.Struct({
    names: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(50)),
  }),
  success: Schema.Struct({ icons: Schema.Record(Schema.String, ExtensionIconDataUri) }),
  error: ExtensionsRpcError,
});
export const WsExtensionsPluginContentsRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginContents,
  {
    payload: ExtensionPluginContentsInput,
    success: ExtensionPluginContents,
    error: ExtensionsRpcError,
  },
);
export const WsExtensionsSkillDocumentRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsSkillDocument,
  {
    payload: ExtensionSkillDocumentInput,
    success: ExtensionSkillDocument,
    error: ExtensionsRpcError,
  },
);

export const WsExtensionsPluginKeysRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginKeys,
  { payload: PluginKeyTarget, success: PluginKeyState, error: ExtensionsRpcError },
);
export const WsExtensionsPluginKeyBindRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginKeyBind,
  { payload: PluginKeyBindInput, success: PluginKeyState, error: ExtensionsRpcError },
);
export const WsExtensionsPluginKeyUnbindRpc = Rpc.make(
  SCIENT_EXTENSION_WS_METHODS.extensionsPluginKeyUnbind,
  { payload: PluginKeyUnbindInput, success: PluginKeyState, error: ExtensionsRpcError },
);
