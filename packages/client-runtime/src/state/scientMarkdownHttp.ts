import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

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
  const payload = new FormData();
  payload.append("cwd", input.cwd);
  payload.append("documentRelativePath", input.documentRelativePath);
  if (input.assetDirectory) payload.append("assetDirectory", input.assetDirectory);
  payload.append("file", input.file, input.fileName);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.imageUpload(),
    timeoutMs: IMAGE_UPLOAD_TIMEOUT_MS,
    group: "scientMarkdown",
    request: ({ client, headers }) => client.imageUpload({ headers, payload }),
  });
});
