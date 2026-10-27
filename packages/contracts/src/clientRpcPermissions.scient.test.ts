import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  sessionGrantsScope,
  type AuthSessionState,
} from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("Accounts client authorization", () => {
  it("requires a current settings grant for credential mutations and user autofill", () => {
    const reader: AuthSessionState = {
      authenticated: true,
      scopes: [AuthOrchestrationReadScope],
      permissions: [AuthOrchestrationReadScope],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "synthetic",
      },
    };
    const writer = {
      ...reader,
      scopes: [AuthSettingsWriteScope],
      permissions: [AuthSettingsWriteScope],
    };
    for (const method of [
      WS_METHODS.accountsPasswordStore,
      WS_METHODS.accountsSave,
      WS_METHODS.accountsHandoffCancel,
      WS_METHODS.accountsHandoffShow,
      WS_METHODS.accountsFillValues,
      WS_METHODS.accountsMatchSignIn,
    ]) {
      const scopes = clientRpcRequiredScopes(method, {});
      expect(scopes.every((scope) => sessionGrantsScope(reader, scope))).toBe(false);
      expect(scopes.every((scope) => sessionGrantsScope(writer, scope))).toBe(true);
    }
  });
});
