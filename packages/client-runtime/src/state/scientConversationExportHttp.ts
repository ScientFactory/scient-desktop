import * as Effect from "effect/Effect";

import type { ScientConversationExportRequest, ThreadId } from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for Scient conversation export. Mirrors `scientThreadQueueHttp.ts`;
 * Scient-owned end to end. See `docs/internals/scient-conversation-export.md`.
 */

const PREPARE_TIMEOUT_MS = 30_000;
// A long conversation with attachments is read, written, and packaged in one request.
const EXPORT_TIMEOUT_MS = 180_000;

export const prepareEnvironmentConversationExport = Effect.fn(
  "clientRuntime.state.prepareEnvironmentConversationExport",
)(function* (input: { readonly prepared: PreparedConnection; readonly threadId: ThreadId }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/conversation-export/v1/prepare"),
    timeoutMs: PREPARE_TIMEOUT_MS,
    group: "scientConversationExport",
    request: ({ client, headers }) =>
      client.prepare({ headers, payload: { threadId: input.threadId } }),
  });
});

export const exportEnvironmentConversation = Effect.fn(
  "clientRuntime.state.exportEnvironmentConversation",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientConversationExportRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/conversation-export/v1/export"),
    timeoutMs: EXPORT_TIMEOUT_MS,
    group: "scientConversationExport",
    request: ({ client, headers }) => client.export({ headers, payload: input.request }),
  });
});

export const prepareEnvironmentConversationWordDiagrams = Effect.fn(
  "clientRuntime.state.prepareEnvironmentConversationWordDiagrams",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientConversationExportRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/conversation-export/v1/word-diagrams"),
    timeoutMs: EXPORT_TIMEOUT_MS,
    group: "scientConversationExport",
    request: ({ client, headers }) =>
      client.prepareWordDiagrams({ headers, payload: input.request }),
  });
});
