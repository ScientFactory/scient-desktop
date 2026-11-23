import { describe, expect, it } from "vite-plus/test";
import {
  AuthFilesystemReadScope,
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
    for (const method of [
      WS_METHODS.computeResultsRerun,
      WS_METHODS.notebookFreshStart,
      WS_METHODS.notebookFreshStop,
    ]) {
      const scopes = clientRpcRequiredScopes(method, {});
      expect(scopes.every((scope) => sessionGrantsScope(reader, scope))).toBe(false);
      expect(scopes.every((scope) => sessionGrantsScope(operator, scope))).toBe(true);
    }
    expect(clientRpcRequiredScopes(WS_METHODS.notebookFreshStatus, {})).toEqual([
      AuthFilesystemReadScope,
    ]);
    // Placing, updating and undoing write project files, so they take the file-write grant.
    for (const method of [
      WS_METHODS.computeResultsPlaceFigure,
      WS_METHODS.computeResultsPlaceLatex,
      WS_METHODS.computeResultsUpdateFiles,
      WS_METHODS.computeResultsUndoUpdate,
      WS_METHODS.notebookEdit,
    ]) {
      const scopes = clientRpcRequiredScopes(method, {});
      expect(scopes.every((scope) => sessionGrantsScope(operator, scope))).toBe(false);
      expect(scopes.every((scope) => sessionGrantsScope(writer, scope))).toBe(true);
    }
  });
});

it("requires a current file-write grant to save or export a data view", () => {
  for (const method of [WS_METHODS.dataSaveView, WS_METHODS.dataMaterializeView]) {
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthFilesystemWriteScope]);
  }
});

it("requires file access and the relevant result grant for package operations", () => {
  const exportScopes = [
    AuthOrchestrationReadScope,
    AuthFilesystemReadScope,
    AuthFilesystemWriteScope,
  ];
  const verifyScopes = [
    AuthOrchestrationOperateScope,
    AuthFilesystemReadScope,
    AuthFilesystemWriteScope,
  ];
  expect(clientRpcRequiredScopes(WS_METHODS.computeResultsExport, {})).toEqual(exportScopes);
  expect(clientRpcRequiredScopes(WS_METHODS.computeResultsExportProgress, {})).toEqual(
    exportScopes,
  );
  expect(clientRpcRequiredScopes(WS_METHODS.computeResultsVerify, {})).toEqual(verifyScopes);
  expect(clientRpcRequiredScopes(WS_METHODS.computeResultsCancelVerification, {})).toEqual(
    verifyScopes,
  );
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
