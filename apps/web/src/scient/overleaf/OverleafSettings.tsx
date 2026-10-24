// SCIENT-OWNED: Overleaf in Settings. Source Control ▸ Overleaf holds the token
// and every linked folder on this computer, by project; Project Settings ▸
// Overleaf holds one project's links and the two ways to add one.
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { SecretInput } from "~/components/settings/SecretInput";
import { SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Label } from "~/components/ui/label";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { useProjects } from "~/state/entities";

import {
  disconnectOverleaf,
  overleafRequestId,
  removeOverleafToken,
  saveOverleafToken,
} from "./client";
import { ConnectOverleafDialog, type ConnectOverleafMode } from "./ConnectOverleafDialog";
import { lastSyncLabel } from "./OverleafFileChip";
import { openOverleafProject, runOverleafSync } from "./overleafActions";
import {
  OVERLEAF_TOKEN_PAGE_URL,
  operationErrorText,
  overleafChipView,
  refusalText,
} from "./overleafModel";
import {
  forgetOverleafConnection,
  reloadOverleafWorkspaces,
  setOverleafTokenSaved,
  useOverleafTokenSaved,
  useOverleafWorkspace,
} from "./overleafStore";

/** The token: Create a token on Overleaf, Save, Remove and whether one is saved. */
function OverleafTokenSettings(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const token = useOverleafTokenSaved(environmentId);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<{ readonly saved: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      const status = await operation();
      setOverleafTokenSaved(environmentId, status.saved);
      setDraft("");
    } catch (failure) {
      setError(operationErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) void run(() => saveOverleafToken(environmentId, draft.trim()));
      }}
    >
      <fieldset disabled={busy} className="contents">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`overleaf-token-${environmentId}`}>Git token</Label>
          <InlineButton
            render={<a href={OVERLEAF_TOKEN_PAGE_URL} target="_blank" rel="noreferrer noopener" />}
          >
            Create a token on Overleaf
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </div>
        <SecretInput
          id={`overleaf-token-${environmentId}`}
          size="sm"
          configured={token.saved}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" role="status">
            {!token.loaded ? "Checking…" : token.saved ? "Saved." : "No token saved."}
          </p>
          <div className="flex shrink-0 gap-2">
            {token.saved ? (
              <Button
                size="xs"
                variant="outline"
                type="button"
                onClick={() => void run(() => removeOverleafToken(environmentId))}
              >
                Remove
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!draft.trim()}>
              Save
            </Button>
          </div>
        </div>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}

/** One project's links: status, last sync, Sync now, Open in Overleaf and Unlink. */
function OverleafProjectLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Shown above the links when several projects are listed. */
  readonly projectName?: string;
  /** Shown when the project has no links; nothing when absent. */
  readonly empty?: string;
}) {
  const { environmentId, workspaceRoot } = props;
  const workspace = useOverleafWorkspace(environmentId, workspaceRoot);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  if (workspace.connections.length === 0) {
    return props.empty && workspace.loaded ? (
      <p className="text-xs text-muted-foreground">{props.empty}</p>
    ) : null;
  }
  const unlink = async (connectionId: string) => {
    setUnlinking(connectionId);
    try {
      const result = await disconnectOverleaf(environmentId, {
        workspaceRoot,
        connectionId,
        requestId: overleafRequestId(),
      });
      // Unlinked: what this window remembered of the link (its review, decisions) goes too.
      if (result._tag === "done") forgetOverleafConnection(environmentId, connectionId);
      if (result._tag === "refused") {
        toastManager.add({
          type: "error",
          title: "Couldn't unlink",
          description: refusalText({ reason: result.reason }),
        });
      }
    } catch (failure) {
      toastManager.add({
        type: "error",
        title: "Couldn't unlink",
        description: operationErrorText(failure),
      });
    } finally {
      setUnlinking(null);
      void reloadOverleafWorkspaces(environmentId, workspaceRoot);
    }
  };
  return (
    <div className="grid gap-2" aria-label={props.projectName ?? "Linked folders"}>
      {props.projectName ? (
        <p className="text-xs font-medium text-muted-foreground">{props.projectName}</p>
      ) : null}
      <ul className="grid gap-2">
        {workspace.connections.map((connection) => {
          const syncing = workspace.syncing.has(connection.connectionId);
          const view = overleafChipView(
            workspace.statuses.get(connection.connectionId) ?? null,
            syncing,
          );
          return (
            <li
              key={connection.connectionId}
              className="flex flex-col gap-2 rounded-lg border border-border/70 px-3 py-2 sm:flex-row sm:items-center"
              data-overleaf-link={connection.connectionId}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {connection.folder === "" ? "Project's top folder" : connection.folder}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {view.label} ·{" "}
                  {lastSyncLabel({
                    lastSyncAt: workspace.syncedAt.get(connection.connectionId) ?? null,
                    completedSyncCount: connection.completedSyncCount,
                    updatedAt: connection.updatedAt,
                  })}
                  {connection.linkedHere ? "" : " · Another copy"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={syncing}
                  onClick={() => void runOverleafSync({ environmentId, workspaceRoot, connection })}
                >
                  {syncing ? "Syncing…" : "Sync now"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => openOverleafProject(connection.projectId)}
                >
                  Open in Overleaf
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={unlinking === connection.connectionId || syncing}
                  onClick={() => void unlink(connection.connectionId)}
                >
                  Unlink
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Settings ▸ Source Control: Overleaf's row beside GitHub and the other providers. */
export function OverleafSourceControlRow(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const token = useOverleafTokenSaved(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20">
      <div className="px-3 py-3 sm:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <OverleafMark aria-hidden className="size-4 shrink-0" />
            <span className="truncate text-sm font-medium text-foreground">Overleaf</span>
            {token.loaded ? (
              <Badge variant={token.saved ? "success" : "outline"} size="sm">
                {token.saved ? "Token saved" : "No token"}
              </Badge>
            ) : null}
          </div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-label="Toggle Overleaf details"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </div>
      </div>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleContent>
          <div className="grid gap-5 px-3 pt-1 pb-4 sm:px-4">
            <OverleafTokenSettings environmentId={environmentId} />
            {expanded ? (
              <div className="grid gap-3">
                <p className="text-xs font-medium text-foreground">Linked folders</p>
                {projects.map((project) => (
                  <OverleafProjectLinks
                    key={project.workspaceRoot}
                    environmentId={environmentId}
                    workspaceRoot={project.workspaceRoot}
                    projectName={project.title}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Project Settings ▸ Overleaf: this project's links, Link a folder… and Bring in a project…. */
export function OverleafProjectSettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const [connect, setConnect] = useState<ConnectOverleafMode | null>(null);
  return (
    <SettingsSection title="Overleaf" icon={<OverleafMark aria-hidden className="size-4" />}>
      <div className="grid gap-3 px-3 py-3 sm:px-4">
        <OverleafProjectLinks
          environmentId={props.environmentId}
          workspaceRoot={props.workspaceRoot}
          empty="No folder is linked."
        />
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => setConnect("link")}>
            Link a folder…
          </Button>
          <Button size="xs" variant="outline" onClick={() => setConnect("new")}>
            Bring in an Overleaf project…
          </Button>
        </div>
      </div>
      {connect ? (
        <ConnectOverleafDialog
          environmentId={props.environmentId}
          cwd={props.workspaceRoot}
          folder=""
          folderEditable={connect === "link"}
          initialMode={connect}
          onClose={() => setConnect(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
