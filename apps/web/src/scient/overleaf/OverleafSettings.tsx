// SCIENT-OWNED: Overleaf in Settings. Synced folders ▸ Overleaf holds the token
// and every linked folder on this computer, by project; Project Settings ▸
// Overleaf holds one project's links.
import type { EnvironmentId, ScientOverleafUnreadableRecord } from "@t3tools/contracts";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import type { Icon } from "~/components/Icons";
import { SecretInput } from "~/components/settings/SecretInput";
import {
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { Button, InlineButton } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";
import { useProjects } from "~/state/entities";

import { removeOverleafToken, saveOverleafToken, setAsideUnreadableOverleafRecord } from "./client";
import { lastSyncLabel } from "./OverleafFileChip";
import {
  openOverleafProject,
  runOverleafSync,
  settleOverleafOperation,
  unlinkOverleaf,
} from "./overleafActions";
import {
  OVERLEAF_TOKEN_PAGE_URL,
  operationErrorText,
  overleafChipView,
  setAsideAction,
  unreadableRecordLines,
} from "./overleafModel";
import {
  loadOverleafWorkspace,
  setOverleafTokenSaved,
  useOverleafTokenSaved,
  useNoOverleafLinks,
  useOverleafListError,
  useOverleafUnreadableRecords,
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
    await settleOverleafOperation(
      async () => {
        const status = await operation();
        setOverleafTokenSaved(environmentId, status.saved);
        setDraft("");
      },
      (failure) => setError(operationErrorText(failure)),
      () => setBusy(false),
    );
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
            tone="muted"
            className="text-xs"
            render={<a href={OVERLEAF_TOKEN_PAGE_URL} target="_blank" rel="noreferrer noopener" />}
          >
            Create a token on Overleaf
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </div>
        <div className="flex items-center gap-2">
          <SecretInput
            id={`overleaf-token-${environmentId}`}
            size="sm"
            className="min-w-0 flex-1"
            configured={token.saved}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
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
  /**
   * Each link is its own row of the settings card it sits in (Project Settings), divided like
   * every other settings row; otherwise a plain divided list inside another row's details.
   */
  readonly asSettingsRows?: boolean;
}) {
  const { environmentId, workspaceRoot, asSettingsRows = false } = props;
  const workspace = useOverleafWorkspace(environmentId, workspaceRoot);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  if (workspace.connections.length === 0) {
    if (!props.empty) return null;
    const padded = asSettingsRows && "px-3 py-3 sm:px-4";
    return workspace.error !== null ? (
      <p className={cn("text-xs text-destructive", padded)} role="alert">
        {listErrorText(workspace.error)}
      </p>
    ) : workspace.loaded ? (
      <p className={cn("text-xs text-muted-foreground", padded)}>{props.empty}</p>
    ) : null;
  }
  const unlink = async (connectionId: string) => {
    setUnlinking(connectionId);
    await unlinkOverleaf(environmentId, workspaceRoot, connectionId);
    setUnlinking(null);
  };
  const Row = asSettingsRows ? "div" : "li";
  const rows = workspace.connections.map((connection) => {
    const syncing = workspace.syncing.has(connection.connectionId);
    const view = overleafChipView(
      workspace.statuses.get(connection.connectionId) ?? null,
      syncing,
      workspace.lastSync.get(connection.connectionId)?.result ?? null,
      workspace.remoteStates.get(connection.connectionId) ?? null,
    );
    const folderGone =
      workspace.statuses.get(connection.connectionId)?.availability === "unavailable";
    return (
      <Row
        key={connection.connectionId}
        {...(asSettingsRows
          ? {
              "data-slot": "settings-row",
              role: "group",
              "aria-label": connection.folder === "" ? "Project's top folder" : connection.folder,
            }
          : {})}
        className={cn(
          "flex flex-col gap-2 sm:flex-row sm:items-center",
          asSettingsRows ? "px-3 py-3 sm:px-4" : "py-2.5",
        )}
        data-overleaf-link={connection.connectionId}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium tracking-subtle text-foreground">
            {connection.folder === "" ? "Project's top folder" : connection.folder}
          </p>
          {view.state === "problem" ? (
            <p className="text-xs text-destructive">{view.detail}</p>
          ) : (
            <p className="truncate text-xs text-muted-foreground">
              {view.label} ·{" "}
              {lastSyncLabel({
                lastSyncAt: workspace.syncedAt.get(connection.connectionId) ?? null,
                completedSyncCount: connection.completedSyncCount,
                updatedAt: connection.updatedAt,
              })}
              {connection.linkedHere ? "" : " · Another copy"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {folderGone ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={syncing}
              onClick={() => void runOverleafSync({ environmentId, workspaceRoot, connection })}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          )}
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
      </Row>
    );
  });
  // Rows of the card itself: the settings group divides them like its other rows.
  if (asSettingsRows) return <>{rows}</>;
  return (
    <div className="grid gap-1" aria-label={props.projectName ?? "Linked folders"}>
      {props.projectName ? (
        <p className="text-xs font-medium text-muted-foreground">{props.projectName}</p>
      ) : null}
      <ul className="divide-y divide-border/50">{rows}</ul>
    </div>
  );
}

const listErrorText = (error: string) => `Couldn't read the linked folders. ${error}`;

/**
 * Link records this release can't read (damaged, or made by a newer Scient), one row each
 * with its folder when the record names it. They stop linking, and bulk folder changes
 * while they may hold an unfinished sync, until they're set aside or settled.
 */
function OverleafUnreadableRecords(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly records: ReadonlyArray<ScientOverleafUnreadableRecord>;
}) {
  const { environmentId, workspaceRoots, records } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [firstRoot] = workspaceRoots;
  if (firstRoot === undefined) return null;
  const setAside = (record: ScientOverleafUnreadableRecord, acceptUnfinished: boolean) => {
    setBusy(record.recordId);
    setErrors((current) => {
      const next = new Map(current);
      next.delete(record.recordId);
      return next;
    });
    void settleOverleafOperation(
      async () => {
        await setAsideUnreadableOverleafRecord(environmentId, {
          workspaceRoot: firstRoot,
          recordId: record.recordId,
          acceptUnfinished,
        });
        await Promise.all(
          workspaceRoots.map((root) => loadOverleafWorkspace(environmentId, root, { force: true })),
        );
      },
      (cause) =>
        setErrors((current) => new Map(current).set(record.recordId, operationErrorText(cause))),
      () => setBusy(null),
    );
  };
  return (
    <div className="grid gap-3">
      <p className="text-xs text-foreground">
        {records.length === 1
          ? "Scient can't read one of its Overleaf link records."
          : `Scient can't read ${records.length} of its Overleaf link records.`}
      </p>
      {records.some((record) => record.setAside !== "held") ? (
        <p className="text-xs text-muted-foreground">
          Setting a record aside moves it to a recovery folder, and nothing on Overleaf changes. The
          link's kept copies stay on disk, but Scient can no longer list or restore them.
        </p>
      ) : null}
      <div className="grid divide-y divide-border">
        {records.map((record) => {
          const lines = unreadableRecordLines(record);
          const action = setAsideAction(record);
          const error = errors.get(record.recordId);
          return (
            <div
              key={record.recordId}
              className="grid gap-1 py-2 first:pt-0 last:pb-0"
              data-unreadable-record
            >
              <p className="break-all text-xs font-medium text-foreground">
                {record.folder ?? "Folder not recorded"}
              </p>
              <p className="text-xs text-muted-foreground">{lines.state}</p>
              <p className="text-xs text-muted-foreground">{lines.holds}</p>
              {action === null ? null : (
                <div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setAside(record, action.acceptUnfinished)}
                  >
                    {action.label}
                  </Button>
                </div>
              )}
              {error ? (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Every project's links on this computer, or a line saying none is linked. */
export function OverleafLinkedFolders(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const workspaceRoots = projects.map((project) => project.workspaceRoot);
  const noneLinked = useNoOverleafLinks(environmentId, workspaceRoots);
  const listError = useOverleafListError(environmentId, workspaceRoots);
  const unreadable = useOverleafUnreadableRecords(environmentId, workspaceRoots);
  return (
    <div className="grid gap-3">
      <p className="text-xs font-medium text-foreground">Linked folders</p>
      {unreadable.length > 0 ? (
        <OverleafUnreadableRecords
          environmentId={environmentId}
          workspaceRoots={workspaceRoots}
          records={unreadable}
        />
      ) : null}
      {listError !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {listErrorText(listError)}
        </p>
      ) : noneLinked ? (
        <p className="text-xs text-muted-foreground">No folder is linked.</p>
      ) : null}
      {projects.map((project) => (
        <OverleafProjectLinks
          key={project.workspaceRoot}
          environmentId={environmentId}
          workspaceRoot={project.workspaceRoot}
          projectName={project.title}
        />
      ))}
    </div>
  );
}

/**
 * Settings ▸ Synced folders: Overleaf's row, drawn like a Source Control row
 * (mark with a status dot, one status line, details on expand). It has no
 * switch: Overleaf has nothing to turn on, a folder syncs once it's linked.
 */
export function OverleafSyncedFolderRow(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const token = useOverleafTokenSaved(environmentId);
  const [expanded, setExpanded] = useState(false);
  const target = searchableSetting("synced-folders-overleaf").id;
  // A search jump to Overleaf opens its details.
  const searchTargetId = useSettingsSearchTargetId();
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  if (searchTargetId === target && !expanded && seenSearchTargetId !== searchTargetId) {
    setExpanded(true);
  }
  if (seenSearchTargetId !== searchTargetId) setSeenSearchTargetId(searchTargetId);
  return (
    <SettingsSearchTarget
      id={target}
      className="first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20"
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <SyncedFolderMark
                Mark={OverleafMark}
                dot={!token.loaded ? null : token.saved ? "bg-success" : "bg-warning"}
              />
              <span className="truncate text-sm font-medium text-foreground">Overleaf</span>
            </div>
            <p className="text-xs leading-normal text-muted-foreground/80" role="status">
              {!token.loaded ? "Checking…" : token.saved ? "Token saved" : "No token saved"}
            </p>
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
            {/* Read each project's links only once the details are open. */}
            {expanded ? <OverleafLinkedFolders environmentId={environmentId} /> : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SettingsSearchTarget>
  );
}

/** A service's mark with Source Control's status dot at its corner; no dot while unknown. */
export function SyncedFolderMark(props: { readonly Mark: Icon; readonly dot: string | null }) {
  const { Mark } = props;
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Mark aria-hidden className="size-4" />
      {props.dot ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
            props.dot,
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}

/** Project Settings ▸ Overleaf: this project's links. New links are made from the Files bar. */
export function OverleafProjectSettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  return (
    <SettingsSection title="Overleaf" icon={<OverleafMark aria-hidden className="size-4" />}>
      <OverleafProjectLinks
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        empty="No folder is linked."
        asSettingsRows
      />
    </SettingsSection>
  );
}
