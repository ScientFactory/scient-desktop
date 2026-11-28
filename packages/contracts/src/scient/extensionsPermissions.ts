import { AuthSettingsWriteScope } from "../auth.ts";
import { SCIENT_EXTENSION_WS_METHODS as methods } from "./extensionRpcs.ts";
import { SCIENT_WHATSAPP_WS_METHODS as whatsapp } from "./whatsapp.ts";
export const SCIENT_EXTENSION_GUARDED_RPC_SCOPES = {
  [methods.extensionsPluginKeyBind]: AuthSettingsWriteScope,
  [methods.extensionsPluginKeyUnbind]: AuthSettingsWriteScope,
  [methods.providerPluginsAct]: AuthSettingsWriteScope,
  [methods.extensionsConnectorAdd]: AuthSettingsWriteScope,
  [methods.extensionsConnectorStartSignIn]: AuthSettingsWriteScope,
  [methods.extensionsConnectorUpdate]: AuthSettingsWriteScope,
  [methods.extensionsConnectorRemove]: AuthSettingsWriteScope,
  [methods.extensionsConnectorTest]: AuthSettingsWriteScope,
  [methods.extensionsConnectorInspectLocal]: AuthSettingsWriteScope,
  [methods.extensionsConnectorImportable]: AuthSettingsWriteScope,
  [methods.extensionsConnectorUndo]: AuthSettingsWriteScope,
  [methods.extensionsConnectorExport]: AuthSettingsWriteScope,
  [methods.extensionsPluginInstall]: AuthSettingsWriteScope,
  [methods.extensionsPluginRemove]: AuthSettingsWriteScope,
  [methods.extensionsPluginSetEnabled]: AuthSettingsWriteScope,
  // The WhatsApp status carries the live QR code, so reading it needs the grant linking does.
  [whatsapp.whatsappStatus]: AuthSettingsWriteScope,
  [whatsapp.whatsappSubscribeStatus]: AuthSettingsWriteScope,
  [whatsapp.whatsappStartLink]: AuthSettingsWriteScope,
  [whatsapp.whatsappCancelLink]: AuthSettingsWriteScope,
  [whatsapp.whatsappUnlink]: AuthSettingsWriteScope,
} as const;
