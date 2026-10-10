import * as Effect from "effect/Effect";

import type {
  ConversationImportId,
  ScientConversationImportConfirmRequest,
  ScientConversationImportCreateUploadRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for Scient conversation import: admit an upload, preview the staged
 * file, confirm or cancel. The file's bytes go to the signed URL the admission
 * returns, not through these calls. Mirrors `scientConversationExportHttp.ts`.
 */

const REQUEST_TIMEOUT_MS = 30_000;
// Validation reads, hashes, and stages every entry of a package of up to 768 MB.
const PREVIEW_TIMEOUT_MS = 300_000;
// Publishing attachments and committing a long history happen in one request.
const IMPORT_TIMEOUT_MS = 300_000;

export const createEnvironmentConversationImportUpload = Effect.fn(
  "clientRuntime.state.createEnvironmentConversationImportUpload",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly upload: ScientConversationImportCreateUploadRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.createUpload(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientConversationImport",
    request: ({ client, headers }) => client.createUpload({ headers, payload: input.upload }),
  });
});

export const previewEnvironmentConversationImport = Effect.fn(
  "clientRuntime.state.previewEnvironmentConversationImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly importId: ConversationImportId;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.preview(),
    timeoutMs: PREVIEW_TIMEOUT_MS,
    group: "scientConversationImport",
    request: ({ client, headers }) =>
      client.preview({ headers, payload: { importId: input.importId } }),
  });
});

export const confirmEnvironmentConversationImport = Effect.fn(
  "clientRuntime.state.confirmEnvironmentConversationImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientConversationImportConfirmRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.import(),
    timeoutMs: IMPORT_TIMEOUT_MS,
    group: "scientConversationImport",
    request: ({ client, headers }) => client.import({ headers, payload: input.request }),
  });
});

export const cancelEnvironmentConversationImport = Effect.fn(
  "clientRuntime.state.cancelEnvironmentConversationImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly importId: ConversationImportId;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.cancel(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientConversationImport",
    request: ({ client, headers }) =>
      client.cancel({ headers, payload: { importId: input.importId } }),
  });
});
