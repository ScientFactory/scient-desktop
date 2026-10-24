// SCIENT-OWNED: the Overleaf chip in the header of every file inside a linked
// folder, next to "Saved". It reads the offline status; clicking it offers
// Sync now, the last sync, Open in Overleaf and Overleaf settings.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, FileDiff, RefreshCw, Settings } from "lucide-react";
import { useEffect } from "react";

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
import { cn } from "~/lib/utils";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { openOverleafProject, runOverleafSync } from "./overleafActions";
import { connectionForPath, overleafChipView } from "./overleafModel";
import { openOverleafReview, seeOverleafChanges } from "./openOverleafReview";
import { refreshOverleafStatus, useOverleafWorkspace } from "./overleafStore";

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

  // A save of this file changes what there is to send: read the status again.
  useEffect(() => {
    if (connectionId === null) return;
    const pendingNow = () =>
      markdownPersistenceRegistry
        .getSnapshot()
        .some(
          (entry) =>
            entry.environmentId === environmentId &&
            entry.cwd === cwd &&
            entry.relativePath === relativePath &&
            entry.pending,
        );
    let wasPending = pendingNow();
    return markdownPersistenceRegistry.subscribe(() => {
      const pending = pendingNow();
      if (wasPending && !pending) void refreshOverleafStatus(environmentId, cwd, connectionId);
      wasPending = pending;
    });
  }, [environmentId, cwd, relativePath, connectionId]);

  if (!connection) return null;
  const status = workspace.statuses.get(connection.connectionId) ?? null;
  const syncing = workspace.syncing.has(connection.connectionId);
  const view = overleafChipView(status, syncing);
  const linkedElsewhere = !connection.linkedHere;
  const last = workspace.lastSync.get(connection.connectionId);
  const reviewInput = {
    environmentId,
    cwd,
    connectionId: connection.connectionId,
    folder: connection.folder,
  };
  const openReview = threadRef ? () => openOverleafReview(threadRef, reviewInput) : undefined;
  const seeChanges = threadRef ? () => seeOverleafChanges(threadRef, reviewInput) : undefined;
  const attention = view.state === "decision" || view.state === "problem";

  return (
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
        <MenuItem
          disabled={syncing}
          onClick={() =>
            void runOverleafSync({ environmentId, workspaceRoot: cwd, connection, openReview })
          }
        >
          <RefreshCw aria-hidden className="size-4 text-muted-foreground" />
          {linkedElsewhere ? "Sync the main copy" : "Sync now"}
        </MenuItem>
        {seeChanges ? (
          <MenuItem onClick={seeChanges}>
            <FileDiff aria-hidden className="size-4 text-muted-foreground" />
            See changes
          </MenuItem>
        ) : null}
        <MenuItem disabled>
          <span className="ps-6 text-xs text-muted-foreground">
            {lastSyncLabel({
              lastSyncAt: last?.at ?? null,
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
        <MenuItem onClick={() => void navigate({ to: "/settings/source-control" })}>
          <Settings aria-hidden className="size-4 text-muted-foreground" />
          Overleaf settings…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
