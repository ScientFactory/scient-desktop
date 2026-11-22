import { describe, expect, it } from "vite-plus/test";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
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

describe("Linked results client authorization", () => {
  it("lets a reader see results but not copy figures into the project or re-run scripts", () => {
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
    const operator = {
      ...reader,
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    };
    const writer = {
      ...reader,
      scopes: [AuthFilesystemWriteScope],
      permissions: [AuthFilesystemWriteScope],
    };
    const rerun = clientRpcRequiredScopes(WS_METHODS.computeResultsRerun, {});
    expect(rerun.every((scope) => sessionGrantsScope(reader, scope))).toBe(false);
    expect(rerun.every((scope) => sessionGrantsScope(operator, scope))).toBe(true);
    // Placing, updating and undoing write project files, so they take the file-write grant.
    for (const method of [
      WS_METHODS.computeResultsPlaceFigure,
      WS_METHODS.computeResultsPlaceLatex,
      WS_METHODS.computeResultsUpdateFiles,
      WS_METHODS.computeResultsUndoUpdate,
    ]) {
      const scopes = clientRpcRequiredScopes(method, {});
      expect(scopes.every((scope) => sessionGrantsScope(operator, scope))).toBe(false);
      expect(scopes.every((scope) => sessionGrantsScope(writer, scope))).toBe(true);
    }
  });
});

describe("Plugin sign-in client authorization", () => {
  it("takes the provider management grant, as an MCP sign-in does", () => {
    const operator: AuthSessionState = {
      authenticated: true,
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "synthetic",
      },
    };
    const manager = {
      ...operator,
      scopes: [AuthProvidersManageScope],
      permissions: [AuthProvidersManageScope],
    };
    const scopes = clientRpcRequiredScopes(WS_METHODS.pluginSignInOpen, {});
    expect(scopes.every((scope) => sessionGrantsScope(operator, scope))).toBe(false);
    expect(scopes.every((scope) => sessionGrantsScope(manager, scope))).toBe(true);
  });
});

describe("Managed runtime client authorization", () => {
  it("takes the provider management grant the server checks, not the settings grant", () => {
    const base: AuthSessionState = {
      authenticated: true,
      scopes: [],
      permissions: [],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "synthetic",
      },
    };
    const settingsWriter = {
      ...base,
      scopes: [AuthSettingsWriteScope],
      permissions: [AuthSettingsWriteScope],
    };
    const manager = {
      ...base,
      scopes: [AuthProvidersManageScope],
      permissions: [AuthProvidersManageScope],
    };
    for (const method of [
      WS_METHODS.serverPlanProviderRuntime,
      WS_METHODS.serverStartProviderRuntime,
      WS_METHODS.serverCancelProviderRuntime,
    ]) {
      const scopes = clientRpcRequiredScopes(method, {});
      expect(scopes.every((scope) => sessionGrantsScope(settingsWriter, scope))).toBe(false);
      expect(scopes.every((scope) => sessionGrantsScope(manager, scope))).toBe(true);
    }
  });
});
