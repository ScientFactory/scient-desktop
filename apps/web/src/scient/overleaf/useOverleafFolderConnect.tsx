// SCIENT-OWNED: what the Files panel needs for Overleaf: the Connect dialog
// for a folder, and the folders that carry Overleaf's mark in the tree.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";

import { ConnectOverleafDialog, type ConnectOverleafMode } from "./ConnectOverleafDialog";
import { openOverleafReview } from "./openOverleafReview";
import { useOverleafWorkspace } from "./overleafStore";

/** Connect to Overleaf for a folder of the Files panel. */
export function useOverleafConnectDialog(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const { environmentId, cwd } = input;
  const threadRef = useThreadRouteRef();
  const [request, setRequest] = useState<{
    readonly folder: string;
    readonly mode: ConnectOverleafMode;
  } | null>(null);

  const dialog =
    request === null ? null : (
      <ConnectOverleafDialog
        environmentId={environmentId}
        cwd={cwd}
        folder={request.folder}
        initialMode={request.mode}
        onSeeChanges={
          threadRef
            ? (connection) =>
                openOverleafReview(threadRef, {
                  cwd,
                  connectionId: connection.connectionId,
                  folder: connection.folder,
                })
            : undefined
        }
        onClose={() => setRequest(null)}
      />
    );

  return {
    /** Opens Connect to Overleaf for `folder` (relative; empty for the project's top). */
    openConnect: (folder: string, mode: ConnectOverleafMode = "new") =>
      setRequest({ folder, mode }),
    dialog,
  };
}

/**
 * Keeps `foldersRef` on the folders linked to Overleaf, in this checkout or
 * another copy of the project, and asks the tree to redraw its marks when
 * they change.
 */
export function useOverleafTreeMarks(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Host folders outside the workspace are never linked. */
  readonly enabled: boolean;
  readonly foldersRef: { current: ReadonlySet<string> };
  readonly onFoldersChanged: () => void;
}): void {
  const { environmentId, cwd, enabled, foldersRef, onFoldersChanged } = input;
  const workspace = useOverleafWorkspace(enabled ? environmentId : null, enabled ? cwd : null);
  const folderKey = workspace.connections
    .map((connection) => connection.folder)
    .toSorted()
    .join("\u0000");
  useEffect(() => {
    foldersRef.current = new Set(folderKey === "" ? [] : folderKey.split("\u0000"));
    onFoldersChanged();
  }, [folderKey, foldersRef, onFoldersChanged]);
}
