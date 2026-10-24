// SCIENT-OWNED: Overleaf's kept copies of one file, inside its "Retained file
// versions" menu. A sync keeps the bytes it replaces; Restore puts one back as
// an ordinary local change for the next sync.
import type { EnvironmentId, ScientOverleafKeptCopies } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";

import { openFileOnLinkedCopy } from "./askAgentOnLinkedCopy";
import { listOverleafKeptCopies, overleafRequestId, restoreOverleafKeptCopy } from "./client";
import { connectionForPath, operationErrorText, workspacePathOf } from "./overleafModel";
import {
  loadOverleafWorkspace,
  useOverleafWorkspace,
  type OverleafConnection,
} from "./overleafStore";

type KeptCopy = ScientOverleafKeptCopies["copies"][number];

const RESTORE_TEXT: Record<"restored" | "stale" | "unknown-copy" | "duplicate", string> = {
  restored: "Restored. The next sync sends it.",
  stale: "The file or the copy changed since this list was read. Nothing was restored.",
  "unknown-copy": "That copy is no longer kept. Nothing was restored.",
  duplicate: "That restore already ran.",
};

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

  const restore = async (copy: KeptCopy) => {
    if (copy.keptRevision === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await restoreOverleafKeptCopy(environmentId, {
        workspaceRoot: cwd,
        connectionId: connection.connectionId,
        requestId: overleafRequestId(),
        applyId: copy.applyId,
        kept: copy.kept,
        keptRevision: copy.keptRevision,
        currentRevision: copy.currentRevision,
      });
      setMessage(RESTORE_TEXT[result._tag]);
      await load(connection.connectionId);
      void loadOverleafWorkspace(environmentId, cwd, { force: true });
    } catch (error) {
      setMessage(operationErrorText(error));
    } finally {
      setBusy(false);
    }
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
            </li>
          ))}
        </ul>
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
