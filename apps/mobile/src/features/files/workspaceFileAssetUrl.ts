import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { isAbsolutePath, isVideoPreviewFile, resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const absolutePath = useMemo(
    () =>
      props.cwd !== null && props.relativePath !== null
        ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
        : null,
    [props.cwd, props.relativePath],
  );

  // Videos stream from an exact-file URL, and so does anything outside the
  // workspace, where no workspace-scoped URL can exist.
  const relativePath = props.relativePath;
  const resource = useMemo<AssetResource | null>(() => {
    if (props.cwd === null || relativePath === null) return null;
    if (
      absolutePath !== null &&
      props.threadId !== null &&
      (isVideoPreviewFile(absolutePath) || isAbsolutePath(relativePath))
    ) {
      return {
        _tag: "media-file",
        threadId: props.threadId,
        path: absolutePath,
      };
    }
    return {
      _tag: "workspace-file",
      cwd: props.cwd,
      relativePath,
      ...(absolutePath !== null && props.threadId !== null
        ? { threadId: props.threadId, path: absolutePath }
        : {}),
    };
  }, [absolutePath, props.cwd, props.threadId, relativePath]);
  const state = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}
