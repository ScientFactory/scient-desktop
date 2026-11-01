import { AuthSettingsWriteScope } from "../auth.ts";
import { SCIENT_EXTENSION_WS_METHODS as methods } from "./extensionRpcs.ts";
export const SCIENT_EXTENSION_GUARDED_RPC_SCOPES = {
  [methods.extensionsPluginKeyBind]: AuthSettingsWriteScope,
  [methods.extensionsPluginKeyUnbind]: AuthSettingsWriteScope,
  [methods.providerPluginsAct]: AuthSettingsWriteScope,
  [methods.extensionsConnectorAdd]: AuthSettingsWriteScope,
  [methods.extensionsConnectorStartSignIn]: AuthSettingsWriteScope,
  [methods.extensionsConnectorUpdate]: AuthSettingsWriteScope,
  [methods.extensionsConnectorRemove]: AuthSettingsWriteScope,
  [methods.extensionsConnectorTest]: AuthSettingsWriteScope,
  [methods.extensionsPluginInstall]: AuthSettingsWriteScope,
  [methods.extensionsPluginRemove]: AuthSettingsWriteScope,
  [methods.extensionsPluginSetEnabled]: AuthSettingsWriteScope,
} as const;
