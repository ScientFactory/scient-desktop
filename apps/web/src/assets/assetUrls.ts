import { AuthFilesystemReadScope } from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { useStableCallback } from "~/hooks/useStableCallback";
import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { readEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

// SCIENT-FORK:START — every state carries `refresh`, so a failed signed URL can be re-minted.
export type AssetUrlState = RuntimeAssetUrlState & {
  readonly refresh: () => void;
  readonly waiting?: boolean;
};
// SCIENT-FORK:END

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);

/**
 * Pass `revision` for a workspace file whose bytes can change under the same
 * path; each new revision gets a freshly minted URL.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
): AssetUrlState {
  // SCIENT-FORK:START — Scient gates `environment-file` too and returns `refresh` in every state;
  // `reason` mirrors client-runtime's `blockedAssetUrlState`.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const canReadResource = fileAccess.canReadFiles || resource === null || !isFileResource(resource);
  const preparedConnection = usePreparedConnection(environmentId);
  const assetAtom =
    !canReadResource || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId, input: { resource }, revision });
  const result = useAtomValue(assetAtom);
  const refresh = useAtomRefresh(assetAtom);
  if (!canReadResource) {
    if (fileAccess.isPending) return { _tag: "Loading", refresh };
    // An error means the session check itself failed, such as when offline.
    return fileAccess.error === null
      ? { _tag: "Failure", refresh, reason: "missing-file-access" }
      : { _tag: "Failure", refresh };
  }
  return {
    ...assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    ),
    refresh,
    ...(result.waiting ? { waiting: true } : {}),
  };
  // SCIENT-FORK:END
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  // SCIENT-FORK:START — a stable callback: mint effects key on its identity, and a new
  // identity on every render re-mints the URL and remounts heavy previews (Office).
  return useStableCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    // SCIENT-FORK:START — file access can be revoked while the signed URL is minted.
    const needsReadAccess = isFileResource(resource);
    if (needsReadAccess && !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
      return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (needsReadAccess && !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
      return null;
    // SCIENT-FORK:END
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  });
  // SCIENT-FORK:END
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = canReadFiles
    ? resources
    : resources.filter((resource) => !isFileResource(resource));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  if (preparedConnection._tag === "None") return resources.map(() => null);
  const urls: Array<string | null> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    if (!canReadFiles && isFileResource(resource)) {
      urls.push(null);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    urls.push(
      result && AsyncResult.isSuccess(result)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null,
    );
  }
  return urls;
}

function isFileResource(resource: AssetResource): boolean {
  return (
    // SCIENT-FORK:START — environment files need `filesystem:read` too.
    resource._tag === "environment-file" ||
    // SCIENT-FORK:END
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file" ||
    (resource._tag === "native-app-icon" && resource.app._tag === "app-path")
  );
}
