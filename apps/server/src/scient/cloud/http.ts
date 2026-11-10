import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentFilePath,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { ScientCloud } from "./ScientCloud.ts";

/** Attachment links in a share build stay valid while the person previews and publishes. */
const SHARE_BLOB_URL_MS = 30 * 60_000;

export const scientCloudHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientCloud",
  Effect.fnUntraced(function* (handlers) {
    const cloud = yield* ScientCloud;
    const authorize = (name: string, scope: AuthEnvironmentScope) =>
      annotateEnvironmentRequest(name).pipe(Effect.andThen(requireEnvironmentScope(scope)));
    return handlers
      .handle("status", ({ endpoint }) =>
        authorize(endpoint.name, AuthOrchestrationReadScope).pipe(Effect.andThen(cloud.status)),
      )
      .handle("enrollmentProof", ({ endpoint, payload }) =>
        authorize(endpoint.name, AuthRelayWriteScope).pipe(
          Effect.andThen(cloud.enrollmentProof(payload)),
        ),
      )
      .handle("enrollmentComplete", ({ endpoint, payload }) =>
        authorize(endpoint.name, AuthRelayWriteScope).pipe(
          Effect.andThen(cloud.enrollmentComplete(payload.userId)),
        ),
      )
      .handle("setEnabled", ({ endpoint, payload }) =>
        authorize(endpoint.name, AuthSettingsWriteScope).pipe(
          Effect.andThen(cloud.setEnabled(payload.enabled)),
        ),
      )
      .handle("stop", ({ endpoint, payload }) =>
        authorize(endpoint.name, AuthRelayWriteScope).pipe(
          Effect.andThen(cloud.stop(payload.deleteCopies)),
        ),
      )
      .handle("shareBuild", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* authorize(endpoint.name, AuthOrchestrationReadScope);
          const built = yield* cloud.shareBuild(payload);
          const blobs = [];
          for (const { path, ...blob } of built.blobs) {
            const asset = yield* issueAssetUrl({
              resource: {
                _tag: "environment-file",
                path: EnvironmentFilePath.make(path),
                access: "exact",
              },
              expiresInMs: SHARE_BLOB_URL_MS,
            }).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_cloud_operation_failed", cause),
              ),
            );
            blobs.push({ ...blob, relativeUrl: asset.relativeUrl });
          }
          return { ...built, blobs };
        }),
      )
      .handle("takeOver", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          const principal = yield* authorize(endpoint.name, AuthOrchestrationOperateScope);
          return yield* cloud.takeOver(payload, principal);
        }),
      );
  }),
);
