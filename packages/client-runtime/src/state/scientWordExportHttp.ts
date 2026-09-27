import * as Effect from "effect/Effect";

import type { ScientWordFileExportRequest, ScientWordLatexExportRequest } from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for Scient Word export: the managed Pandoc tool (status and install)
 * and project Markdown files to Word. Scient-owned end to end; mirrors
 * `scientConversationExportHttp.ts`.
 */

const TOOL_TIMEOUT_MS = 30_000;
// Reading the file, two Pandoc passes, and writing the result, in one request.
const EXPORT_TIMEOUT_MS = 360_000;

export const getEnvironmentWordExportTool = Effect.fn(
  "clientRuntime.state.getEnvironmentWordExportTool",
)(function* (input: { readonly prepared: PreparedConnection }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/word-export/v1/tool"),
    timeoutMs: TOOL_TIMEOUT_MS,
    group: "scientWordExport",
    request: ({ client, headers }) => client.tool({ headers }),
  });
});

export const installEnvironmentWordExportTool = Effect.fn(
  "clientRuntime.state.installEnvironmentWordExportTool",
)(function* (input: { readonly prepared: PreparedConnection }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/word-export/v1/tool/install"),
    timeoutMs: TOOL_TIMEOUT_MS,
    group: "scientWordExport",
    // The server starts the install and answers with the state it left; the
    // client polls the tool to watch it finish.
    request: ({ client, headers }) => client.installTool({ headers }),
  });
});

export const exportEnvironmentWordFile = Effect.fn("clientRuntime.state.exportEnvironmentWordFile")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly request: ScientWordFileExportRequest;
  }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/word-export/v1/file"),
      timeoutMs: EXPORT_TIMEOUT_MS,
      group: "scientWordExport",
      request: ({ client, headers }) => client.exportFile({ headers, payload: input.request }),
    });
  },
);

export const exportEnvironmentWordLatex = Effect.fn(
  "clientRuntime.state.exportEnvironmentWordLatex",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientWordLatexExportRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/word-export/v1/latex"),
    timeoutMs: EXPORT_TIMEOUT_MS,
    group: "scientWordExport",
    request: ({ client, headers }) => client.exportLatex({ headers, payload: input.request }),
  });
});
