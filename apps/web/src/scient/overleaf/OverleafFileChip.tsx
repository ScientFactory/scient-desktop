// SCIENT-OWNED: the Overleaf chip in the header of every file inside a linked
// folder, next to "Saved". It reads the offline status; clicking it offers
// Sync now, the last sync, Undo last send, Open in Overleaf and Overleaf settings.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, FileDiff, RefreshCw, Settings, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { cancelOverleafRun, openOverleafProject, runOverleafSync } from "./overleafActions";
import { connectionForPath, overleafChipView } from "./overleafModel";
import { openOverleafReview, seeOverleafChanges } from "./openOverleafReview";
import { ensureOverleafSaveWatch } from "./overleafSaveWatch";
import { revalidateOverleafStatus, useOverleafWorkspace } from "./overleafStore";
import { OverleafUndoDialog } from "./OverleafUndoDialog";
import { useOverleafAgentRunWatch } from "./useOverleafAgentRunWatch";

/** A status read this recently is used as it is when a chip appears. */
const STATUS_FRESH_MS = 5_000;

/** When the link last synced: this window's last sync, or the link's own record. */
export function lastSyncLabel(input: {
  readonly lastSyncAt: number | null;
  readonly completedSyncCount: number;
  readonly updatedAt: string;
}): string {
  if (input.lastSyncAt !== null) {
    return `Last synced ${formatRelativeTimeLabel(new Date(input.lastSyncAt).toISOString())}`;
  }
  if (input.completedSyncCount === 0) return "Not synced yet";
  return `Last synced ${formatRelativeTimeLabel(input.updatedAt)}`;
}

export function OverleafFileChip(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { environmentId, cwd, relativePath, threadRef } = props;
  const workspace = useOverleafWorkspace(environmentId, cwd);
  const navigate = useNavigate();
  const connection = connectionForPath(workspace.connections, relativePath);
  const connectionId = connection?.connectionId ?? null;
  const [undoing, setUndoing] = useState(false);

  useOverleafAgentRunWatch(environmentId, cwd);
  // Saves are watched for the app's lifetime (overleafSaveWatch); a chip that mounts reads a
  // status a save made stale, or one older than a few seconds, again.
  // oxlint-disable-next-line t3code/react-effect-budget -- A chip appearing re-reads the server's status if a save made it stale; the save watch starts with the first chip.
  useEffect(() => {
    ensureOverleafSaveWatch();
    if (connectionId !== null)
      revalidateOverleafStatus(environmentId, cwd, connectionId, STATUS_FRESH_MS);
  }, [environmentId, cwd, connectionId]);

  if (!connection) return null;
  const status = workspace.statuses.get(connection.connectionId) ?? null;
  const syncing = workspace.syncing.has(connection.connectionId);
  const view = overleafChipView(
    status,
    syncing,
    workspace.lastSync.get(connection.connectionId)?.result ?? null,
  );
  const linkedElsewhere = !connection.linkedHere;
  const reviewInput = {
    environmentId,
    cwd,
    connectionId: connection.connectionId,
    folder: connection.folder,
  };
  const openReview = threadRef ? () => openOverleafReview(threadRef, reviewInput) : undefined;
  const seeChanges = threadRef ? () => seeOverleafChanges(threadRef, reviewInput) : undefined;
  const attention = view.state === "decision" || view.state === "problem";
  const syncNow = () =>
    void runOverleafSync({ environmentId, workspaceRoot: cwd, connection, openReview });

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant={attention ? "ghost-warning" : "ghost"}
              className="shrink-0"
              aria-label={`Overleaf: ${view.label}`}
              data-overleaf-chip={view.state}
            />
          }
        >
          {attention ? (
            <AlertTriangle className="size-3.5" aria-hidden="true" />
          ) : (
            <OverleafMark
              aria-hidden
              className={cn("size-3.5", view.state === "syncing" && "animate-pulse")}
            />
          )}
          <span className="max-w-32 truncate">{view.label}</span>
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6} className="min-w-60">
          <MenuGroup>
            <MenuGroupLabel>
              <span className="block text-foreground">
                Overleaf · {connection.folder === "" ? "this project" : connection.folder}
              </span>
              {linkedElsewhere ? (
                <span className="block font-normal">This link belongs to the main copy.</span>
              ) : view.detail ? (
                <span className="block font-normal">{view.detail}</span>
              ) : null}
            </MenuGroupLabel>
          </MenuGroup>
          {view.state === "syncing" ? (
            // A running sync stops at its next stage boundary, never inside an apply or a send.
            <MenuItem
              onClick={() => void cancelOverleafRun(environmentId, cwd, connection.connectionId)}
            >
              <X aria-hidden className="size-4 text-muted-foreground" />
              Cancel sync
            </MenuItem>
          ) : (
            <MenuItem onClick={syncNow}>
              <RefreshCw aria-hidden className="size-4 text-muted-foreground" />
              {linkedElsewhere ? "Sync the main copy" : "Sync now"}
            </MenuItem>
          )}
          {seeChanges ? (
            <MenuItem onClick={seeChanges}>
              <FileDiff aria-hidden className="size-4 text-muted-foreground" />
              See changes
            </MenuItem>
          ) : null}
          {view.state === "syncing" || connection.completedSyncCount === 0 ? null : (
            <MenuItem onClick={() => setUndoing(true)}>
              <Undo2 aria-hidden className="size-4 text-muted-foreground" />
              Undo last send…
            </MenuItem>
          )}
          <MenuItem disabled>
            <span className="ps-6 text-xs text-muted-foreground">
              {lastSyncLabel({
                lastSyncAt: workspace.syncedAt.get(connection.connectionId) ?? null,
                completedSyncCount: connection.completedSyncCount,
                updatedAt: connection.updatedAt,
              })}
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => openOverleafProject(connection.projectId)}>
            <ExternalLink aria-hidden className="size-4 text-muted-foreground" />
            Open in Overleaf
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/settings/synced-folders" })}>
            <Settings aria-hidden className="size-4 text-muted-foreground" />
            Overleaf settings…
          </MenuItem>
        </MenuPopup>
      </Menu>
      {connection.linkedHere ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={
                  view.state === "syncing" ? "Syncing with Overleaf…" : "Sync with Overleaf"
                }
                disabled={view.state === "syncing"}
                onClick={syncNow}
              />
            }
          >
            <RefreshCw
              aria-hidden
              className={cn(
                "scient-quiet-icon size-4",
                view.state === "syncing" && "animate-pulse",
              )}
              strokeWidth={1.75}
            />
          </TooltipTrigger>
          <TooltipPopup>
            {view.state === "syncing" ? "Syncing…" : "Sync with Overleaf"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {undoing ? (
        <OverleafUndoDialog
          environmentId={environmentId}
          workspaceRoot={cwd}
          connection={connection}
          openReview={openReview}
          onClose={() => setUndoing(false)}
        />
      ) : null}
    </>
  );
}
