import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const IMAGE_UPLOAD_TIMEOUT_MS = 120_000;

export const uploadEnvironmentMarkdownImage = Effect.fn(
  "clientRuntime.state.uploadEnvironmentMarkdownImage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly cwd: string;
  readonly documentRelativePath: string;
  readonly file: Blob;
  readonly fileName: string;
  readonly assetDirectory?: string | undefined;
}) {
  const path = "/api/scient/markdown/images/upload";
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, path);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  const payload = new FormData();
  payload.append("cwd", input.cwd);
  payload.append("documentRelativePath", input.documentRelativePath);
  if (input.assetDirectory) payload.append("assetDirectory", input.assetDirectory);
  payload.append("file", input.file, input.fileName);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    IMAGE_UPLOAD_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.scientMarkdown.imageUpload({ headers, payload }),
    ),
  );
});
