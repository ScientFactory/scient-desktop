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
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

/**
 * Every LaTeX endpoint answers from server-side build state rather than waiting
 * on the compiler, so they all share the short request budget. The compile
 * itself is observed by polling the status endpoint.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/** A cold toolchain probe shells out to the engine, which can be slow on first run. */
const TOOLCHAIN_TIMEOUT_MS = 30_000;

const requestContext = Effect.fn("clientRuntime.state.scientLatexRequestContext")(
  function* (input: { readonly prepared: PreparedConnection; readonly path: string }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      signer,
    );
    return { requestUrl, client, headers };
  },
);

export const getEnvironmentLatexBuild = Effect.fn("clientRuntime.state.getEnvironmentLatexBuild")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexBuildRequest["workspaceRoot"];
    readonly relativePath: ScientLatexBuildRequest["relativePath"];
  }) {
    const context = yield* requestContext({
      prepared: input.prepared,
      path: "/api/scient/latex/build",
    });
    return yield* executeEnvironmentHttpRequest(
      context.requestUrl,
      REQUEST_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        context.client.scientLatex.build({
          headers: context.headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
      ),
    );
  },
);

export const getEnvironmentLatexStatus = Effect.fn("clientRuntime.state.getEnvironmentLatexStatus")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexStatusRequest["workspaceRoot"];
    readonly relativePath: ScientLatexStatusRequest["relativePath"];
  }) {
    const context = yield* requestContext({
      prepared: input.prepared,
      path: "/api/scient/latex/status",
    });
    return yield* executeEnvironmentHttpRequest(
      context.requestUrl,
      REQUEST_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        context.client.scientLatex.status({
          headers: context.headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
      ),
    );
  },
);

export const getEnvironmentLatexCancel = Effect.fn("clientRuntime.state.getEnvironmentLatexCancel")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly workspaceRoot: ScientLatexCancelRequest["workspaceRoot"];
    readonly relativePath: ScientLatexCancelRequest["relativePath"];
  }) {
    const context = yield* requestContext({
      prepared: input.prepared,
      path: "/api/scient/latex/cancel",
    });
    return yield* executeEnvironmentHttpRequest(
      context.requestUrl,
      REQUEST_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        context.client.scientLatex.cancel({
          headers: context.headers,
          payload: {
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
          },
        }),
      ),
    );
  },
);

export const getEnvironmentLatexForwardSync = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexForwardSync",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientLatexForwardSyncRequest;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/latex/synctex/forward",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientLatex.forwardSync({
        headers: context.headers,
        payload: input.request,
      }),
    ),
  );
});

export const getEnvironmentLatexInverseSync = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexInverseSync",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientLatexInverseSyncRequest;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/latex/synctex/inverse",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientLatex.inverseSync({
        headers: context.headers,
        payload: input.request,
      }),
    ),
  );
});

export const getEnvironmentLatexInstallToolchain = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexInstallToolchain",
)(function* (input: { readonly prepared: PreparedConnection }) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/latex/toolchain/install",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      // The server only starts the install and answers with the state it left
      // behind, so this request is as short as the rest of the group.
      context.client.scientLatex.installToolchain({ headers: context.headers }),
    ),
  );
});

export const getEnvironmentLatexToolchain = Effect.fn(
  "clientRuntime.state.getEnvironmentLatexToolchain",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly refresh: ScientLatexToolchainRequest["refresh"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/latex/toolchain",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    TOOLCHAIN_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientLatex.toolchain({
        headers: context.headers,
        payload: { refresh: input.refresh },
      }),
    ),
  );
});
