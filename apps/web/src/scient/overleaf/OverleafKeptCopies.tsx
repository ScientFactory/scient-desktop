// SCIENT-OWNED: Overleaf's kept copies of one file, inside its "Retained file
// versions" menu. A sync keeps the bytes it replaces; Restore puts one back as
// an ordinary local change for the next sync.
import type {
  EnvironmentId,
  ScientOverleafKeptCopies,
  ScientOverleafRestoreResult,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { useFileContextMenu } from "~/fileContextMenu";
import { toastManager } from "~/components/ui/toast";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

import { openFileOnLinkedCopy } from "./askAgentOnLinkedCopy";
import { listOverleafKeptCopies, overleafRequestId, restoreOverleafKeptCopy } from "./client";
import { connectionForPath, operationErrorText, workspacePathOf } from "./overleafModel";
import {
  reloadOverleafWorkspaces,
  useOverleafWorkspace,
  type OverleafConnection,
} from "./overleafStore";

type KeptCopy = ScientOverleafKeptCopies["copies"][number];

/**
 * What a restore did. Only a complete apply put the copy back: a replanned one
 * wrote nothing, and one that needs attention may have stopped partway.
 */
function restoreText(result: ScientOverleafRestoreResult): string {
  switch (result._tag) {
    case "restored":
      return result.outcome === "complete"
        ? "Restored. The next sync sends it."
        : result.outcome === "replan"
          ? "The file changed while restoring, so nothing was written. Try again."
          : "The restore needs attention: it may have stopped partway. Check the file before syncing.";
    case "stale":
      return "The file or the copy changed since this list was read. Nothing was restored.";
    case "unknown-copy":
      return "That copy is no longer kept. Nothing was restored.";
    case "duplicate":
      return "That restore already ran.";
  }
}

// Outside the component: the React Compiler does not compile try/finally.
async function settleOverleafOperation(
  task: () => Promise<void>,
  failed: (error: unknown) => void,
  settled: () => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    failed(error);
  } finally {
    settled();
  }
}

/** From another worktree: the kept copies are the linked copy's; this offers to open it there. */
function KeptInLinkedCopy(props: {
  readonly environmentId: EnvironmentId;
  readonly connection: OverleafConnection;
  readonly relativePath: string;
}) {
  const threadRef = useThreadRouteRef();
  const handleNewThread = useNewThreadHandler();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <section className="mt-4 flex flex-col gap-2 text-xs" aria-label="Kept by Overleaf sync">
      <p className="font-medium">Kept by Overleaf sync</p>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-muted-foreground">Kept copies are in the main copy.</p>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void openFileOnLinkedCopy({
              environmentId: props.environmentId,
              threadRef,
              connection: props.connection,
              handleNewThread,
              relativePath: props.relativePath,
            }).then((opened) => {
              if (!opened) setMessage("The main copy's file couldn't be opened.");
            })
          }
        >
          Open there
        </Button>
      </div>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

export function OverleafKeptCopies(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}) {
  const { environmentId, cwd, relativePath } = props;
  // The app's own file reveal: offered only where this environment can show a local file.
  const revealLabel = useFileContextMenu(environmentId).capabilities.revealLabel;
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const workspace = useOverleafWorkspace(environmentId, cwd);
  const connection = connectionForPath(workspace.connections, relativePath);
  // Kept copies belong to the linked copy: from another worktree they aren't this file's.
  const linkedHere = connection?.linkedHere ?? false;
  const connectionId = connection !== null && linkedHere ? connection.connectionId : null;

  const [copies, setCopies] = useState<ReadonlyArray<KeptCopy> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (id: string) => {
    try {
      const listed = await listOverleafKeptCopies(environmentId, {
        workspaceRoot: cwd,
        connectionId: id,
      });
      setCopies(listed.copies);
    } catch (error) {
      setMessage(operationErrorText(error));
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The menu showing reads the link's kept copies from the server; a read for a link no longer shown is dropped.
  useEffect(() => {
    if (connectionId === null) return;
    let cancelled = false;
    listOverleafKeptCopies(environmentId, { workspaceRoot: cwd, connectionId }).then(
      (listed) => {
        if (!cancelled) setCopies(listed.copies);
      },
      (error: unknown) => {
        if (!cancelled) setMessage(operationErrorText(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, cwd, connectionId]);

  if (!connection) return null;
  if (!linkedHere)
    return (
      <KeptInLinkedCopy
        environmentId={environmentId}
        connection={connection}
        relativePath={relativePath}
      />
    );
  const mine = (copies ?? []).filter(
    (copy) => workspacePathOf(connection.folder, copy.relativePath) === relativePath,
  );

  // A kept copy lives outside the workspace, so it is revealed by its absolute path.
  const reveal = async (copy: KeptCopy) => {
    const result = await openInEditor({
      environmentId,
      input: { cwd: copy.path, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Unable to reveal file", description: copy.path });
  };

  const restore = async (copy: KeptCopy) => {
    const { keptRevision } = copy;
    if (keptRevision === null) return;
    setBusy(true);
    setMessage(null);
    await settleOverleafOperation(
      async () => {
        const result = await restoreOverleafKeptCopy(environmentId, {
          workspaceRoot: cwd,
          connectionId: connection.connectionId,
          requestId: overleafRequestId(),
          applyId: copy.applyId,
          kept: copy.kept,
          keptRevision,
          currentRevision: copy.currentRevision,
        });
        setMessage(restoreText(result));
        await load(connection.connectionId);
      },
      (error) => setMessage(operationErrorText(error)),
      () => {
        setBusy(false);
        void reloadOverleafWorkspaces(environmentId, cwd);
      },
    );
  };

  return (
    <section className="mt-4 flex flex-col gap-2 text-xs" aria-label="Kept by Overleaf sync">
      <p className="font-medium">Kept by Overleaf sync</p>
      {copies === null && message === null ? (
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      ) : mine.length === 0 && copies !== null ? (
        <p className="text-muted-foreground">No kept copies of this file.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {mine.map((copy) => (
            <li key={copy.kept} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {new Date(copy.retainedAt).toLocaleString()}
                {copy.state === "changed" ? " · changed since kept" : ""}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || copy.keptRevision === null || copy.unread}
                onClick={() => void restore(copy)}
              >
                Restore
              </Button>
              {revealLabel !== undefined ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || copy.keptRevision === null || copy.unread}
                  onClick={() => void reveal(copy)}
                >
                  {revealLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
