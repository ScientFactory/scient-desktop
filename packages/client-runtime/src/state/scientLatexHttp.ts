import * as Effect from "effect/Effect";

import type {
  ScientLatexBuildRequest,
  ScientLatexCancelRequest,
  ScientLatexForwardSyncRequest,
  ScientLatexInverseSyncRequest,
  ScientLatexStatusRequest,
  ScientLatexToolchainRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Every LaTeX endpoint answers from server-side build state rather than waiting
 * on the compiler, so they all share the short request budget. The compile
 * itself is observed by polling the status endpoint.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/** A cold toolchain probe shells out to the engine, which can be slow on first run. */
const TOOLCHAIN_TIMEOUT_MS = 30_000;

export const getEnvironmentLatexBuild = Effect.fn("clientRuntime.state.getEnvironmentLatexBuild")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexBuildRequest["workspaceRoot"];
    readonly relativePath: ScientLatexBuildRequest["relativePath"];
  }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/build"),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.scientLatex.build({
          headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
    });
  },
);

export const getEnvironmentLatexStatus = Effect.fn("clientRuntime.state.getEnvironmentLatexStatus")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexStatusRequest["workspaceRoot"];
    readonly relativePath: ScientLatexStatusRequest["relativePath"];
  }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/status"),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.scientLatex.status({
          headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
    });
  },
);

export const getEnvironmentLatexCancel = Effect.fn("clientRuntime.state.getEnvironmentLatexCancel")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexCancelRequest["workspaceRoot"];
    readonly relativePath: ScientLatexCancelRequest["relativePath"];
  }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/cancel"),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.scientLatex.cancel({
          headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
    });
  },
);

export const getEnvironmentLatexForwardSync = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexForwardSync",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientLatexForwardSyncRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/synctex/forward"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientLatex.forwardSync({
        headers,
        payload: input.request,
      }),
  });
});

export const getEnvironmentLatexInverseSync = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexInverseSync",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientLatexInverseSyncRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/synctex/inverse"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientLatex.inverseSync({
        headers,
        payload: input.request,
      }),
  });
});

export const getEnvironmentLatexInstallToolchain = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexInstallToolchain",
)(function* (input: { readonly prepared: PreparedConnection }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/toolchain/install"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      // The server only starts the install and answers with the state it left
      // behind, so this request is as short as the rest of the group.
      client.scientLatex.installToolchain({ headers }),
  });
});

export const getEnvironmentLatexToolchain = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexToolchain",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly refresh: ScientLatexToolchainRequest["refresh"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/latex/toolchain"),
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientLatex.toolchain({
        headers,
        payload: { refresh: input.refresh },
      }),
  });
});
