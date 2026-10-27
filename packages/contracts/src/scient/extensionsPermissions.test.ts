import { describe, expect, it } from "vite-plus/test";
import { AuthSettingsWriteScope } from "../auth.ts";
import { clientRpcRequiredScopes } from "../clientRpcPermissions.ts";
import { SCIENT_EXTENSION_WS_METHODS as methods } from "./extensionRpcs.ts";
import { SCIENT_EXTENSION_GUARDED_RPC_SCOPES } from "./extensionsPermissions.ts";
describe("extensions client grants", () => {
  it("gates owner mutations while store reads remain available to readers", () => {
    for (const method of Object.keys(SCIENT_EXTENSION_GUARDED_RPC_SCOPES))
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthSettingsWriteScope]);
    expect(
      clientRpcRequiredScopes(methods.providerPluginsAct, {
        action: { type: "install", entryId: "sample" },
      }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(clientRpcRequiredScopes(methods.extensionsPluginKeyBind, {})).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(clientRpcRequiredScopes(methods.extensionsPluginKeyUnbind, {})).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(clientRpcRequiredScopes(methods.extensionsPluginKeys, {})).toEqual([]);
    expect(clientRpcRequiredScopes(methods.extensionsProviderStoreSearch, {})).toEqual([]);
  });
});
