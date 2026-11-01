import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { usePreparedConnection } from "~/state/session";

export function useWorkspaceImageRefresh(input: {
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  readonly workspaceMutationId: string | null | undefined;
  readonly loading: boolean;
  readonly requestRefresh: () => void;
}) {
  const { environmentId, resource, workspaceMutationId, loading, requestRefresh } = input;
  const connectionReady = usePreparedConnection(environmentId)._tag === "Some";
  const refreshToken = JSON.stringify([environmentId, resource, workspaceMutationId]);
  const handledRefreshToken = useRef<string | null | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests an image reload over the environment connection when the workspace mutation stream advances
  useEffect(() => {
    if (!connectionReady) {
      handledRefreshToken.current = null;
      return;
    }
    if (
      workspaceMutationId === undefined ||
      (resource._tag !== "media-file" && resource._tag !== "workspace-file") ||
      handledRefreshToken.current === refreshToken
    ) {
      return;
    }
    if (loading) {
      // Only the initial mount shares a pending request; edits and reconnects need a new one.
      if (handledRefreshToken.current === undefined) {
        handledRefreshToken.current = refreshToken;
      }
      return;
    }
    handledRefreshToken.current = refreshToken;
    requestRefresh();
  }, [connectionReady, loading, refreshToken, requestRefresh, resource._tag, workspaceMutationId]);
}
