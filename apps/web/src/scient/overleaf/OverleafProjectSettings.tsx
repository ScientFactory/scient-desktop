import type {
  EnvironmentId,
  ScientOverleafAccount,
  ScientOverleafCommitPolicy,
  ScientOverleafConflictDetail,
  ScientOverleafConnection,
  ScientOverleafOperationSnapshot,
  ScientOverleafOverview,
  ScientOverleafReview,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { overleafClient } from "./client";
import { OverleafTextDiff } from "./OverleafTextDiff";
import { overleafAuthorEmailError, overleafOperationFailureMessage } from "./validation";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly projectName: string;
}

const ACTIVE_PHASES = new Set<ScientOverleafOperationSnapshot["phase"]>([
  "preparing",
  "fetching",
  "rebasing",
  "pushing",
  "projecting",
  "publishing",
]);

const TERMINAL_PHASES = new Set<ScientOverleafOperationSnapshot["phase"]>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const ADVISORY_WARNING_KINDS = new Set([
  "file_count",
  "large_file",
  "large_editable_text",
  "large_editable_material",
  "project_size",
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The Overleaf operation could not be completed.";
}

function connectionStatus(connection: ScientOverleafConnection): string {
  switch (connection.state) {
    case "ready":
      return connection.lastSyncedAtEpochMs === null
        ? "Connected"
        : `Last synchronized ${new Date(connection.lastSyncedAtEpochMs).toLocaleString()}`;
    case "local_ahead":
      return "Local edits are ready for the next manual Sync";
    case "operation_active":
      return "Synchronization is in progress";
    case "push_outcome_unknown":
      return "The last push needs verification";
    case "local_projection_pending":
      return "Overleaf is updated; local projection needs attention";
    case "repair_required":
      return "The private mirror needs repair";
  }
}

function warningLabel(kind: string): string {
  return kind.replaceAll("_", " ");
}

function OutboundSummary({ review }: { readonly review: ScientOverleafReview }) {
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-xs font-medium">
        Last Sync changes: {review.changes.length} file{review.changes.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {review.changes.length === 0 ? (
          <li className="font-sans text-muted-foreground">No outbound file changes.</li>
        ) : (
          review.changes.map((change) => (
            <li key={`${change.kind}:${change.oldPath ?? ""}:${change.path}`}>
              <span className="me-2 uppercase text-muted-foreground">{change.kind[0]}</span>
              {change.oldPath ? `${change.oldPath} → ` : ""}
              {change.path}
            </li>
          ))
        )}
      </ul>
    </details>
  );
}

function AccountEditor(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly account: ScientOverleafAccount | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"cloud" | "server-pro">("cloud");
  const [host, setHost] = useState("git.overleaf.com");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLabel(props.account?.label ?? "Overleaf");
    setKind(props.account?.kind ?? "cloud");
    setHost(props.account?.host ?? "git.overleaf.com");
    setAuthorName(props.account?.authorName ?? "");
    setAuthorEmail(props.account?.authorEmail ?? "");
    setToken("");
    setEmailTouched(false);
  }, [props.account, props.open]);

  const authorEmailError = overleafAuthorEmailError(authorEmail);

  const save = async () => {
    setEmailTouched(true);
    if (authorEmailError !== null) return;
    setSaving(true);
    try {
      await overleafClient.saveAccount(props.environmentId, {
        ...(props.account === null ? {} : { accountId: props.account.accountId }),
        label,
        kind,
        host,
        authorName,
        authorEmail,
        ...(token.trim() === "" ? {} : { token }),
      });
      props.onOpenChange(false);
      props.onSaved();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save Overleaf account",
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.account === null ? "Add Overleaf account" : "Edit Overleaf account"}
          </DialogTitle>
          <DialogDescription>
            Tokens are saved by the environment and are never returned to this browser. Commit
            metadata uses the human identity below.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="grid gap-1.5">
            <Label>Service</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(event) => {
                const next = event.target.value as "cloud" | "server-pro";
                setKind(next);
                if (next === "cloud") setHost("git.overleaf.com");
              }}
            >
              <option value="cloud">Overleaf Cloud</option>
              <option value="server-pro">Overleaf Server Pro</option>
            </select>
          </label>
          <label className="grid gap-1.5">
            <Label>Exact credential host</Label>
            <Input
              value={host}
              disabled={kind === "cloud"}
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <Label>Your name</Label>
              <Input value={authorName} onChange={(event) => setAuthorName(event.target.value)} />
            </label>
            <label className="grid gap-1.5">
              <Label>Your email</Label>
              <Input
                type="email"
                value={authorEmail}
                aria-invalid={emailTouched && authorEmailError !== null ? true : undefined}
                aria-describedby="overleaf-author-email-error"
                onBlur={() => setEmailTouched(true)}
                onChange={(event) => setAuthorEmail(event.target.value)}
              />
              {emailTouched && authorEmailError !== null ? (
                <span
                  id="overleaf-author-email-error"
                  className="text-xs text-destructive"
                  role="alert"
                >
                  {authorEmailError}
                </span>
              ) : null}
            </label>
          </div>
          <label className="grid gap-1.5">
            <Label>
              {props.account === null
                ? "Git authentication token"
                : "New token (leave blank to keep current)"}
            </Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              saving ||
              !label.trim() ||
              !host.trim() ||
              !authorName.trim() ||
              authorEmailError !== null ||
              (props.account === null && !token.trim())
            }
            onClick={() => void save()}
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null} Save account
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FolderBrowserDialog(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly initialPath: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (relativePath: string) => void;
}) {
  const [current, setCurrent] = useState("");
  useEffect(() => {
    if (props.open) setCurrent(props.initialPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
  }, [props.initialPath, props.open]);
  const browse = useEnvironmentQuery(
    props.open
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: {
            cwd: props.workspaceRoot,
            partialPath: current ? `${current}/` : "./",
          },
        })
      : null,
  );
  const parent = current.split("/").filter(Boolean).slice(0, -1).join("/");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a folder on the environment</DialogTitle>
          <DialogDescription>{current || "Workspace root"}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {current ? (
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => setCurrent(parent)}
            >
              ← Parent folder
            </Button>
          ) : null}
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
            {browse.isPending ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" /> Loading folders…
              </div>
            ) : null}
            {browse.error ? (
              <div className="p-3 text-sm text-destructive">{browse.error}</div>
            ) : null}
            {browse.data?.entries.map((entry) => (
              <button
                key={entry.fullPath}
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                onClick={() => setCurrent(current ? `${current}/${entry.name}` : entry.name)}
              >
                {entry.name}
              </button>
            ))}
            {!browse.isPending && !browse.error && browse.data?.entries.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No subfolders here.</div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              props.onSelect(current);
              props.onOpenChange(false);
            }}
          >
            Use {current || "workspace root"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ConnectionWizard(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly projectName: string;
  readonly accounts: ReadonlyArray<ScientOverleafAccount>;
  readonly operation: ScientOverleafOperationSnapshot | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStarted: (operation: ScientOverleafOperationSnapshot) => void;
  readonly onCompleted: (operation: ScientOverleafOperationSnapshot) => void;
  readonly onAddAccount: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [projectInput, setProjectInput] = useState("");
  const [relativeFolder, setRelativeFolder] = useState("");
  const [label, setLabel] = useState(props.projectName);
  const [commitKind, setCommitKind] = useState<ScientOverleafCommitPolicy["kind"]>("neutral");
  const [customMessage, setCustomMessage] = useState("Update project");
  const [mode, setMode] = useState<"combine" | "replace-local" | "replace-overleaf">("combine");
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);

  useEffect(() => {
    if (props.open && !accountId && props.accounts[0]) setAccountId(props.accounts[0].accountId);
  }, [accountId, props.accounts, props.open]);
  useEffect(() => {
    setAcknowledged(false);
  }, [props.operation?.generation]);

  const preflightReady =
    props.operation?.kind === "connect" &&
    props.operation.connectStage === "preflight" &&
    props.operation.phase === "awaiting_push_confirmation";
  const preflightRunning =
    props.operation?.kind === "connect" &&
    props.operation.connectStage === "preflight" &&
    ACTIVE_PHASES.has(props.operation.phase);
  const preflightFailure = overleafOperationFailureMessage(
    props.operation?.kind === "connect" && props.operation.connectStage === "preflight"
      ? props.operation
      : null,
  );
  const warnings = props.operation?.review?.warnings ?? [];
  const selectedAccount = props.accounts.find((account) => account.accountId === accountId) ?? null;
  const newProjectUrl =
    selectedAccount === null
      ? "https://www.overleaf.com/project/new"
      : selectedAccount.kind === "cloud"
        ? "https://www.overleaf.com/project/new"
        : `https://${selectedAccount.host}/project/new`;

  const start = async () => {
    setWorking(true);
    try {
      const commitPolicy: ScientOverleafCommitPolicy =
        commitKind === "custom" ? { kind: "custom", message: customMessage } : { kind: commitKind };
      const operation = await overleafClient.startPreflight(props.environmentId, {
        accountId,
        workspaceRoot: props.workspaceRoot,
        relativeFolder,
        projectInput,
        label,
        commitPolicy,
      });
      props.onStarted(operation);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not check Overleaf project",
        description: errorMessage(error),
      });
    } finally {
      setWorking(false);
    }
  };

  const complete = async () => {
    if (!props.operation) return;
    setWorking(true);
    try {
      const operation = await overleafClient.completePreflight(props.environmentId, {
        operationId: props.operation.operationId,
        generation: props.operation.generation,
        mode,
        acknowledgeWarnings: acknowledged || warnings.length === 0,
      });
      props.onCompleted(operation);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not connect Overleaf project",
        description: errorMessage(error),
      });
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-h-[90dvh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {preflightReady ? "Choose how to connect" : "Connect an Overleaf project"}
          </DialogTitle>
          <DialogDescription>
            Synchronization is manual. The app keeps Git data privately; no .git folder is added to
            your workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65dvh] space-y-4 overflow-y-auto">
          {preflightFailure !== null ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <div className="font-medium">Could not check this Overleaf project</div>
              <div className="mt-1 text-xs">{preflightFailure}</div>
            </div>
          ) : null}
          {preflightRunning ? (
            <div className="flex items-center gap-3 rounded-lg border p-4 text-sm">
              <LoaderCircleIcon className="size-4 animate-spin" />
              <span>{props.operation?.message}</span>
            </div>
          ) : !preflightReady ? (
            <>
              {props.accounts.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Add an Overleaf account before connecting a project.{" "}
                  <Button className="ms-2" size="sm" variant="outline" onClick={props.onAddAccount}>
                    Add account
                  </Button>
                </div>
              ) : (
                <label className="grid gap-1.5">
                  <Label>Account</Label>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    {props.accounts.map((account) => (
                      <option key={account.accountId} value={account.accountId}>
                        {account.label} · {account.authorName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="grid gap-1.5">
                <Label>Overleaf project or Git URL</Label>
                <Textarea
                  value={projectInput}
                  onChange={(event) => setProjectInput(event.target.value)}
                  placeholder="https://www.overleaf.com/project/… or git clone …"
                />
                <span className="text-xs text-muted-foreground">
                  Need a project first?{" "}
                  <a
                    className="inline-flex items-center gap-1 underline"
                    href={newProjectUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create it in Overleaf <ExternalLinkIcon className="size-3" />
                  </a>
                  , then paste its project or Git URL here.
                </span>
              </label>
              <label className="grid gap-1.5">
                <Label>Where should this Overleaf project appear in this workspace?</Label>
                <div className="flex gap-2">
                  <Input
                    value={relativeFolder}
                    onChange={(event) => setRelativeFolder(event.target.value)}
                    placeholder="Leave blank for workspace root, or enter papers/my-paper"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFolderBrowserOpen(true)}
                  >
                    Browse
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  Existing and new subdirectories are supported. The server verifies that the final
                  path stays inside the workspace.
                </span>
              </label>
              <label className="grid gap-1.5">
                <Label>Connection label</Label>
                <Input value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
              <label className="grid gap-1.5">
                <Label>Commit message</Label>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={commitKind}
                  onChange={(event) =>
                    setCommitKind(event.target.value as ScientOverleafCommitPolicy["kind"])
                  }
                >
                  <option value="neutral">Always “Update project”</option>
                  <option value="custom">Always use a custom message</option>
                  <option value="prompt">Ask when a commit is needed</option>
                </select>
              </label>
              {commitKind === "custom" ? (
                <label className="grid gap-1.5">
                  <Label>Custom message</Label>
                  <Input
                    value={customMessage}
                    onChange={(event) => setCustomMessage(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <label className="rounded-lg border p-3">
                  <input
                    className="me-2"
                    type="radio"
                    checked={mode === "combine"}
                    onChange={() => setMode("combine")}
                  />{" "}
                  <strong>Safe Combine</strong>
                  <p className="ms-5 mt-1 text-xs text-muted-foreground">
                    Preserve unique files on both sides and resolve same-path differences.
                  </p>
                </label>
                <label className="rounded-lg border p-3">
                  <input
                    className="me-2"
                    type="radio"
                    checked={mode === "replace-local"}
                    onChange={() => setMode("replace-local")}
                  />{" "}
                  <strong>Replace local</strong>
                  <p className="ms-5 mt-1 text-xs text-muted-foreground">
                    Use Overleaf managed files locally. Replaced files are backed up.
                  </p>
                </label>
                <label className="rounded-lg border p-3">
                  <input
                    className="me-2"
                    type="radio"
                    checked={mode === "replace-overleaf"}
                    onChange={() => setMode("replace-overleaf")}
                  />{" "}
                  <strong>Replace Overleaf</strong>
                  <p className="ms-5 mt-1 text-xs text-muted-foreground">
                    Push the local managed tree without force-pushing. Comments and Track Changes
                    metadata may be displaced.
                  </p>
                </label>
              </div>
              {warnings.length > 0 ? (
                <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                  <div className="mb-2 flex items-center gap-2 font-medium">
                    <AlertTriangleIcon className="size-4" /> Review warnings
                  </div>
                  <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                    {warnings.map((warning) => (
                      <li key={`${warning.kind}:${warning.message}:${warning.paths.join("|")}`}>
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                  <label className="mt-3 flex items-center gap-2">
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    />
                    <span>I reviewed these warnings</span>
                  </label>
                </div>
              ) : null}
              {(props.operation?.review?.changes.length ?? 0) > 0 ? (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Exact managed-file changes ({props.operation!.review!.changes.length})
                  </summary>
                  <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto font-mono text-xs">
                    {props.operation!.review!.changes.map((change) => (
                      <li key={`${change.kind}:${change.oldPath ?? ""}:${change.path}`}>
                        <span className="me-2 uppercase text-muted-foreground">
                          {change.kind[0]}
                        </span>
                        {change.oldPath ? `${change.oldPath} → ` : ""}
                        {change.path}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={working}
            onClick={() => {
              if (!props.operation || ["succeeded", "cancelled"].includes(props.operation.phase)) {
                props.onOpenChange(false);
                return;
              }
              void overleafClient
                .cancel(props.environmentId, props.operation.operationId)
                .then((cancelled) => {
                  props.onCompleted(cancelled);
                  props.onOpenChange(false);
                })
                .catch((error) =>
                  toastManager.add({
                    type: "error",
                    title: "Could not cancel Overleaf connection",
                    description: errorMessage(error),
                  }),
                );
            }}
          >
            {props.operation && !["succeeded", "cancelled"].includes(props.operation.phase)
              ? "Cancel connection"
              : "Close"}
          </Button>
          {preflightReady ? (
            <Button
              disabled={working || (warnings.length > 0 && !acknowledged)}
              onClick={() => void complete()}
            >
              {working ? <LoaderCircleIcon className="animate-spin" /> : null} Connect
            </Button>
          ) : !preflightRunning ? (
            <Button
              disabled={
                working ||
                !accountId ||
                !projectInput.trim() ||
                !label.trim() ||
                (commitKind === "custom" && !customMessage.trim())
              }
              onClick={() => void start()}
            >
              {working ? <LoaderCircleIcon className="animate-spin" /> : null} Check project
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
      <FolderBrowserDialog
        open={folderBrowserOpen}
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        initialPath={relativeFolder}
        onOpenChange={setFolderBrowserOpen}
        onSelect={setRelativeFolder}
      />
    </Dialog>
  );
}

function ConnectionSettingsDialog(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly connection: ScientOverleafConnection | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ScientOverleafCommitPolicy["kind"]>("neutral");
  const [message, setMessage] = useState("Update project");
  const [suppressRenames, setSuppressRenames] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!props.open || !props.connection) return;
    setLabel(props.connection.label);
    setKind(props.connection.commitPolicy.kind);
    setMessage(props.connection.commitPolicy.message ?? "Update project");
    setSuppressRenames(props.connection.suppressRenameWarning);
  }, [props.connection, props.open]);
  if (!props.connection) return null;
  const save = async () => {
    setSaving(true);
    try {
      await overleafClient.updateConnection(props.environmentId, {
        connectionId: props.connection!.connectionId,
        label,
        commitPolicy: kind === "custom" ? { kind, message } : { kind },
        suppressRenameWarning: suppressRenames,
      });
      props.onOpenChange(false);
      props.onSaved();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update Overleaf connection",
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Overleaf connection settings</DialogTitle>
          <DialogDescription>
            Changes affect future manual synchronization operations.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="grid gap-1.5">
            <Label>Commit message policy</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as ScientOverleafCommitPolicy["kind"])
              }
            >
              <option value="neutral">Always “Update project”</option>
              <option value="custom">Custom message</option>
              <option value="prompt">Ask on Sync</option>
            </select>
          </label>
          {kind === "custom" ? (
            <label className="grid gap-1.5">
              <Label>Custom message</Label>
              <Input value={message} onChange={(event) => setMessage(event.target.value)} />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={suppressRenames}
              onCheckedChange={(checked) => setSuppressRenames(checked === true)}
            />
            Don’t require a separate warning for pure renames
          </label>
          <p className="text-xs text-muted-foreground">
            Deletions and historical reverts always require review and cannot be disabled.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={saving || !label.trim() || (kind === "custom" && !message.trim())}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null} Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OperationDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly operation: ScientOverleafOperationSnapshot | null;
  readonly onChanged: (operation: ScientOverleafOperationSnapshot) => void;
  readonly onClose: () => void;
}) {
  const operation = props.operation;
  const [acknowledged, setAcknowledged] = useState(false);
  const [suppressRenames, setSuppressRenames] = useState(false);
  const [detail, setDetail] = useState<ScientOverleafConflictDetail | null>(null);
  const [keepOther, setKeepOther] = useState(false);
  const [keepBothPath, setKeepBothPath] = useState("");
  const [companionPath, setCompanionPath] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setAcknowledged(false);
    setSuppressRenames(false);
    setDetail(null);
    setKeepOther(false);
    setKeepBothPath("");
    setCompanionPath("");
    setCommitMessage("");
  }, [operation?.generation, operation?.operationId]);

  if (!operation) return null;
  const open = [
    "awaiting_commit_message",
    "awaiting_push_confirmation",
    "awaiting_conflicts",
    "awaiting_local_conflicts",
    "push_outcome_unknown",
    "remote_synced_local_pending",
    "failed",
    "interrupted",
  ].includes(operation.phase);
  const unresolved = operation.conflicts.filter((conflict) => !conflict.resolved);
  const advisoryOnly =
    operation.review !== null &&
    operation.review.warnings.length > 0 &&
    operation.review.warnings.every((warning) => ADVISORY_WARNING_KINDS.has(warning.kind));

  const act = async (run: () => Promise<ScientOverleafOperationSnapshot>) => {
    setWorking(true);
    try {
      props.onChanged(await run());
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Overleaf action failed",
        description: errorMessage(error),
      });
      return false;
    } finally {
      setWorking(false);
    }
  };

  const showConflict = async (conflictId: string) => {
    setWorking(true);
    try {
      setDetail(
        await overleafClient.conflict(props.environmentId, operation.operationId, conflictId),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not load conflict",
        description: errorMessage(error),
      });
    } finally {
      setWorking(false);
    }
  };

  const resolve = (resolution: "overleaf" | "local" | "delete" | "both") => {
    if (!detail) return;
    void act(() =>
      overleafClient.resolveConflict(props.environmentId, {
        operationId: operation.operationId,
        generation: operation.generation,
        conflictId: detail.conflict.conflictId,
        resolution,
        ...(resolution === "both" ? { keepBothPath: keepBothPath.trim() } : {}),
        keepOtherSide: (resolution === "overleaf" || resolution === "local") && keepOther,
        ...(companionPath.trim() ? { companionPath: companionPath.trim() } : {}),
      }),
    ).then((succeeded) => {
      if (succeeded) setDetail(null);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-h-[92dvh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {operation.phase === "awaiting_commit_message"
              ? "Name this Overleaf update"
              : operation.phase === "awaiting_push_confirmation"
                ? "Review changes before pushing"
                : operation.phase.includes("conflicts")
                  ? "Resolve Overleaf conflicts"
                  : "Overleaf synchronization needs attention"}
          </DialogTitle>
          <DialogDescription>{operation.message}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[68dvh] overflow-y-auto">
          {operation.phase === "awaiting_commit_message" ? (
            <label className="grid gap-2">
              <Label>Commit message</Label>
              <Input
                autoFocus
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Describe this project update"
              />
              <span className="text-xs text-muted-foreground">
                The local snapshot needs a commit. Overleaf has not been fetched or pushed for this
                Sync yet.
              </span>
            </label>
          ) : null}
          {operation.phase === "awaiting_push_confirmation" && operation.review ? (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-4">
                {(["added", "modified", "renamed", "deleted"] as const).map((kind) => (
                  <div key={kind} className="rounded-lg border p-3">
                    <div className="text-xl font-semibold">
                      {operation.review!.changes.filter((change) => change.kind === kind).length}
                    </div>
                    <div className="text-xs capitalize text-muted-foreground">{kind}</div>
                  </div>
                ))}
              </div>
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">File changes</summary>
                <ul className="mt-2 space-y-1 font-mono text-xs">
                  {operation.review.changes.map((change) => (
                    <li key={`${change.kind}:${change.oldPath ?? ""}:${change.path}`}>
                      <span className="me-2 uppercase text-muted-foreground">{change.kind[0]}</span>
                      {change.oldPath ? `${change.oldPath} → ` : ""}
                      {change.path}
                    </li>
                  ))}
                </ul>
              </details>
              {operation.review.warnings.length > 0 ? (
                <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <ul className="space-y-2 text-sm">
                    {operation.review.warnings.map((warning) => (
                      <li key={`${warning.kind}:${warning.message}:${warning.paths.join("|")}`}>
                        <strong className="capitalize">{warningLabel(warning.kind)}:</strong>{" "}
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                I reviewed this exact candidate
              </label>
              {operation.review.warnings.some(
                (warning) => warning.kind === "rename" && warning.suppressible,
              ) ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={suppressRenames}
                    onCheckedChange={(checked) => setSuppressRenames(checked === true)}
                  />
                  Don’t warn about renames again for this project
                </label>
              ) : null}
            </div>
          ) : null}
          {operation.phase === "awaiting_conflicts" ||
          operation.phase === "awaiting_local_conflicts" ? (
            detail ? (
              <div className="space-y-4">
                <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                  ← All conflicts
                </Button>
                <div className="space-y-1">
                  <div className="font-mono text-sm font-medium">{detail.conflict.path}</div>
                  <div className="text-xs text-muted-foreground">
                    {detail.conflict.kind} · Overleaf {detail.conflict.overleafSize ?? "missing"}{" "}
                    bytes · Local {detail.conflict.localSize ?? "missing"} bytes
                  </div>
                  {detail.conflict.overleafPath || detail.conflict.localPath ? (
                    <div className="font-mono text-[11px] text-muted-foreground">
                      Overleaf: {detail.conflict.overleafPath ?? "deleted"} · Local:{" "}
                      {detail.conflict.localPath ?? "deleted"}
                    </div>
                  ) : null}
                  <div className="font-mono text-[11px] text-muted-foreground">
                    Overleaf hash: {detail.conflict.overleafHash ?? "deleted"}
                    <br />
                    Local hash: {detail.conflict.localHash ?? "deleted"}
                  </div>
                </div>
                {detail.conflict.previewable ? (
                  <div className="space-y-3">
                    <OverleafTextDiff
                      path={detail.conflict.path}
                      overleaf={detail.overleaf ?? ""}
                      local={detail.local ?? ""}
                      overleafHash={detail.conflict.overleafHash}
                      localHash={detail.conflict.localHash}
                    />
                    {detail.base !== null ? (
                      <details className="rounded-lg border p-3">
                        <summary className="cursor-pointer text-xs font-medium">
                          Show Base reference
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                          {detail.base}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                    This binary or structural conflict cannot be previewed. Compare the paths,
                    sizes, and hashes before choosing.
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={keepOther}
                    onCheckedChange={(checked) => setKeepOther(checked === true)}
                  />
                  Preserve the unselected side as a local-only companion
                </label>
                {keepOther ? (
                  <Input
                    value={companionPath}
                    onChange={(event) => setCompanionPath(event.target.value)}
                    placeholder="Optional sibling path; a safe name is generated if blank"
                  />
                ) : null}
                <label className="grid gap-1.5">
                  <Label>Managed path for “Keep both”</Label>
                  <Input
                    value={keepBothPath}
                    onChange={(event) => setKeepBothPath(event.target.value)}
                    placeholder="chapter-overleaf.tex"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => resolve("overleaf")}>Keep Overleaf</Button>
                  <Button variant="outline" onClick={() => resolve("local")}>
                    Keep Local
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!keepBothPath.trim()}
                    onClick={() => resolve("both")}
                  >
                    Keep both
                  </Button>
                  <Button variant="destructive-outline" onClick={() => resolve("delete")}>
                    Delete
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {operation.conflicts.map((conflict) => (
                  <button
                    type="button"
                    key={conflict.conflictId}
                    className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-muted/40"
                    onClick={() => void showConflict(conflict.conflictId)}
                  >
                    <span>
                      <span className="block font-mono text-sm">{conflict.path}</span>
                      <span className="text-xs text-muted-foreground">{conflict.kind}</span>
                    </span>
                    {conflict.resolved ? (
                      <CheckCircle2Icon className="size-4 text-success" />
                    ) : (
                      <span className="text-xs">Resolve</span>
                    )}
                  </button>
                ))}
              </div>
            )
          ) : null}
          {[
            "push_outcome_unknown",
            "remote_synced_local_pending",
            "failed",
            "interrupted",
          ].includes(operation.phase) ? (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
              <AlertTriangleIcon className="mb-2 size-5" />
              {operation.message}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
          {operation.phase === "awaiting_commit_message" ? (
            <Button
              disabled={working || !commitMessage.trim()}
              onClick={() =>
                void act(() =>
                  overleafClient.continueOperation(
                    props.environmentId,
                    operation.operationId,
                    commitMessage,
                  ),
                )
              }
            >
              Continue Sync
            </Button>
          ) : null}
          {operation.phase === "awaiting_push_confirmation" && operation.review ? (
            <Button
              disabled={!acknowledged || working}
              onClick={() =>
                void act(() =>
                  overleafClient.confirmReview(props.environmentId, {
                    operationId: operation.operationId,
                    generation: operation.generation,
                    candidateCommit: operation.review!.candidateCommit,
                    acknowledgeWarnings: acknowledged,
                    suppressFutureRenameWarnings: suppressRenames,
                  }),
                )
              }
            >
              {advisoryOnly ? "Sync anyway" : "Confirm and push"}
            </Button>
          ) : null}
          {(operation.phase === "awaiting_conflicts" ||
            operation.phase === "awaiting_local_conflicts") &&
          unresolved.length === 0 ? (
            <Button
              disabled={working}
              onClick={() =>
                void act(() =>
                  overleafClient.continueOperation(props.environmentId, operation.operationId),
                )
              }
            >
              Continue
            </Button>
          ) : null}
          {operation.phase === "push_outcome_unknown" ||
          operation.phase === "remote_synced_local_pending" ? (
            <Button
              disabled={working}
              onClick={() =>
                void act(() => overleafClient.retry(props.environmentId, operation.operationId))
              }
            >
              Retry
            </Button>
          ) : null}
          {operation.phase === "awaiting_push_confirmation" ||
          operation.phase === "awaiting_conflicts" ? (
            <Button
              disabled={working}
              variant="destructive-outline"
              onClick={() =>
                void act(() => overleafClient.cancel(props.environmentId, operation.operationId))
              }
            >
              Abort Sync
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function OverleafProjectSettings({ environmentId, workspaceRoot, projectName }: Props) {
  const [overview, setOverview] = useState<ScientOverleafOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [accountEditorOpen, setAccountEditorOpen] = useState(false);
  const [editedAccount, setEditedAccount] = useState<ScientOverleafAccount | null>(null);
  const [connectionEditorOpen, setConnectionEditorOpen] = useState(false);
  const [editedConnection, setEditedConnection] = useState<ScientOverleafConnection | null>(null);
  const [operation, setOperation] = useState<ScientOverleafOperationSnapshot | null>(null);
  const [pollOperationId, setPollOperationId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await overleafClient.overview(environmentId, workspaceRoot));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not load Overleaf settings",
        description: errorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  }, [environmentId, workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const track = useCallback((next: ScientOverleafOperationSnapshot) => {
    setOperation(next);
    setPollOperationId(ACTIVE_PHASES.has(next.phase) ? next.operationId : null);
  }, []);

  useEffect(() => {
    if (pollOperationId === null) return;
    const timer = window.setInterval(() => {
      void overleafClient
        .operation(environmentId, pollOperationId)
        .then((next) => {
          setOperation(next);
          if (!ACTIVE_PHASES.has(next.phase)) {
            setPollOperationId(null);
            void refresh();
            if (next.phase === "succeeded") {
              setConnectOpen(false);
              toastManager.add({
                type: "success",
                title: "Overleaf synchronized",
                description: next.message,
              });
            } else {
              const failureMessage = overleafOperationFailureMessage(next);
              if (failureMessage !== null) {
                toastManager.add({
                  type: "error",
                  title:
                    next.kind === "connect" && next.connectStage === "preflight"
                      ? "Could not check Overleaf project"
                      : "Overleaf operation failed",
                  description: failureMessage,
                });
              }
            }
          }
        })
        .catch((error) => {
          setPollOperationId(null);
          toastManager.add({
            type: "error",
            title: "Could not read Overleaf progress",
            description: errorMessage(error),
          });
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [environmentId, pollOperationId, refresh]);

  const connections = useMemo(() => overview?.connections ?? [], [overview]);
  const latestReviews = useMemo(() => {
    const byConnection = new Map<string, ScientOverleafReview>();
    for (const candidate of (overview?.operations ?? []).toSorted(
      (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
    )) {
      if (
        candidate.connectionId !== null &&
        candidate.review !== null &&
        !byConnection.has(candidate.connectionId)
      ) {
        byConnection.set(candidate.connectionId, candidate.review);
      }
    }
    return byConnection;
  }, [overview]);
  const activeOperations = useMemo(() => {
    const byConnection = new Map<string, ScientOverleafOperationSnapshot>();
    for (const candidate of (overview?.operations ?? []).toSorted(
      (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
    )) {
      if (
        candidate.connectionId !== null &&
        !TERMINAL_PHASES.has(candidate.phase) &&
        !byConnection.has(candidate.connectionId)
      ) {
        byConnection.set(candidate.connectionId, candidate);
      }
    }
    return byConnection;
  }, [overview]);
  const unfinishedDrafts = useMemo(
    () =>
      (overview?.operations ?? []).filter(
        (candidate) =>
          candidate.kind === "connect" &&
          candidate.connectStage === "preflight" &&
          !TERMINAL_PHASES.has(candidate.phase),
      ),
    [overview],
  );
  const connectionDraftOperation =
    operation?.kind === "connect" && operation.connectStage === "preflight" ? operation : null;
  const attentionOperation =
    operation?.kind === "connect" && operation.connectStage === "preflight" ? null : operation;

  const startSync = async (connection: ScientOverleafConnection) => {
    try {
      track(
        await overleafClient.startSync(environmentId, {
          connectionId: connection.connectionId,
        }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start Sync",
        description: errorMessage(error),
      });
    }
  };

  const includeCompanion = async (connection: ScientOverleafConnection, path: string) => {
    try {
      await overleafClient.updateConnection(environmentId, {
        connectionId: connection.connectionId,
        includeCompanionPath: path,
      });
      await refresh();
      toastManager.add({
        type: "success",
        title: "Companion will be synchronized",
        description: `${path} will be treated as a normal managed file on the next manual Sync.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not include companion",
        description: errorMessage(error),
      });
    }
  };

  const disconnect = async (connection: ScientOverleafConnection) => {
    try {
      const checked = await overleafClient.disconnect(environmentId, {
        connectionId: connection.connectionId,
        mode: "check",
      });
      const companions =
        checked.companionPaths.length > 0
          ? `\n\nLocal-only companions will remain as ordinary files:\n${checked.companionPaths.join("\n")}`
          : "";
      if (checked.hasUnsyncedChanges) {
        if (
          window.confirm(
            `This folder has unsynchronized changes. Synchronize before disconnecting?${companions}`,
          )
        ) {
          const result = await overleafClient.disconnect(environmentId, {
            connectionId: connection.connectionId,
            mode: "sync-and-disconnect",
          });
          if (result.operation) track(result.operation);
          return;
        }
        if (
          !window.confirm(
            `Disconnect without synchronizing? Workspace files are preserved.${companions}`,
          )
        )
          return;
      } else if (
        !window.confirm(
          `Disconnect this Overleaf project? Workspace files are preserved.${companions}`,
        )
      )
        return;
      await overleafClient.disconnect(environmentId, {
        connectionId: connection.connectionId,
        mode: "disconnect-without-sync",
      });
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not disconnect",
        description: errorMessage(error),
      });
    }
  };

  return (
    <>
      <SettingsSection
        title="Overleaf"
        icon={<GitCompareArrowsIcon className="size-5" />}
        headerAction={
          <Button size="sm" onClick={() => setConnectOpen(true)}>
            <PlusIcon /> Connect
          </Button>
        }
      >
        {loading ? (
          <SettingsRow
            title="Loading Overleaf connections…"
            control={<LoaderCircleIcon className="size-4 animate-spin" />}
          />
        ) : null}
        {!loading && connections.length === 0 ? (
          <SettingsRow
            title="No Overleaf project connected"
            description="Choose where an Overleaf project should appear in this workspace. Synchronization runs only when you click Sync."
          />
        ) : null}
        {unfinishedDrafts.map((draft) => (
          <SettingsRow
            key={draft.operationId}
            title="Unfinished Overleaf connection"
            description={draft.message}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setOperation(draft);
                  setConnectOpen(true);
                  setPollOperationId(ACTIVE_PHASES.has(draft.phase) ? draft.operationId : null);
                }}
              >
                Resume
              </Button>
            }
          />
        ))}
        {connections.map((connection) => (
          <SettingsRow
            key={connection.connectionId}
            title={
              <span className="flex items-center gap-2">
                {connection.label}
                {connection.state === "ready" ? (
                  <CheckCircle2Icon className="size-4 text-success" />
                ) : (
                  <AlertTriangleIcon className="size-4 text-warning" />
                )}
              </span>
            }
            description={
              <span>
                {connection.relativeFolder || "Workspace root"} · {connectionStatus(connection)}
              </span>
            }
            status={
              <div className="flex flex-wrap items-center gap-3">
                <a
                  className="inline-flex items-center gap-1 hover:underline"
                  href={connection.projectUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Overleaf <ExternalLinkIcon className="size-3" />
                </a>
                {latestReviews.get(connection.connectionId) ? (
                  <OutboundSummary review={latestReviews.get(connection.connectionId)!} />
                ) : null}
                {connection.localOnlyCompanions.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-xs">
                      {connection.localOnlyCompanions.length} local-only companion file(s)
                    </summary>
                    <div className="mt-2 space-y-1">
                      {connection.localOnlyCompanions.map((path) => (
                        <div key={path} className="flex items-center gap-2 font-mono text-xs">
                          <span>{path}</span>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => void includeCompanion(connection, path)}
                          >
                            Include on next Sync
                          </Button>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            }
            control={
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  disabled={connection.state !== "ready" && connection.state !== "local_ahead"}
                  onClick={() => void startSync(connection)}
                >
                  <RefreshCwIcon /> Sync
                </Button>
                {activeOperations.get(connection.connectionId) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOperation(activeOperations.get(connection.connectionId)!);
                      setPollOperationId(
                        ACTIVE_PHASES.has(activeOperations.get(connection.connectionId)!.phase)
                          ? activeOperations.get(connection.connectionId)!.operationId
                          : null,
                      );
                    }}
                  >
                    Resume
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditedConnection(connection);
                    setConnectionEditorOpen(true);
                  }}
                >
                  Settings
                </Button>
                {connection.state === "push_outcome_unknown" ||
                connection.state === "local_projection_pending" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const active =
                        overview?.operations.find(
                          (candidate) =>
                            candidate.operationId ===
                            (
                              connection as ScientOverleafConnection & {
                                activeOperationId?: string;
                              }
                            ).activeOperationId,
                        ) ??
                        overview?.operations.find(
                          (candidate) =>
                            candidate.connectionId === connection.connectionId &&
                            ["push_outcome_unknown", "remote_synced_local_pending"].includes(
                              candidate.phase,
                            ),
                        );
                      if (active) {
                        setOperation(active);
                        setPollOperationId(null);
                      }
                    }}
                  >
                    Resolve
                  </Button>
                ) : null}
                {connection.state === "local_projection_pending" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void overleafClient
                        .reconcileLocal(environmentId, connection.connectionId)
                        .then(track)
                        .catch((error) =>
                          toastManager.add({
                            type: "error",
                            title: "Could not reconcile local files",
                            description: errorMessage(error),
                          }),
                        )
                    }
                  >
                    Reconcile local
                  </Button>
                ) : null}
                {connection.state === "repair_required" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void overleafClient
                        .repair(environmentId, connection.connectionId)
                        .then(track)
                        .catch((error) =>
                          toastManager.add({
                            type: "error",
                            title: "Could not repair mirror",
                            description: errorMessage(error),
                          }),
                        )
                    }
                  >
                    <WrenchIcon /> Repair
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={() => void disconnect(connection)}
                >
                  <Trash2Icon /> Disconnect
                </Button>
              </div>
            }
          />
        ))}
        <SettingsRow
          title="Overleaf Git help"
          description="Access errors can have several causes, so the app does not guess your plan entitlement."
          status={
            <span className="flex flex-wrap gap-3">
              <a
                className="underline"
                href="https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git"
                target="_blank"
                rel="noreferrer"
              >
                Availability
              </a>
              <a
                className="underline"
                href="https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git/git-integration-authentication-tokens"
                target="_blank"
                rel="noreferrer"
              >
                Authentication tokens
              </a>
              <a
                className="underline"
                href="https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/advanced-git-operations"
                target="_blank"
                rel="noreferrer"
              >
                Operations and limitations
              </a>
            </span>
          }
        />
        {(overview?.accounts.length ?? 0) > 0 ? (
          <SettingsRow
            title="Saved Overleaf accounts"
            description="One host-scoped account can be reused by multiple projects. Identity changes affect future commits only."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditedAccount(null);
                  setAccountEditorOpen(true);
                }}
              >
                <PlusIcon /> Add account
              </Button>
            }
          >
            {overview!.accounts.map((account) => (
              <div
                key={account.accountId}
                className="flex items-center justify-between border-t py-2 text-sm"
              >
                <span>
                  <strong>{account.label}</strong> · {account.authorName} &lt;{account.authorEmail}
                  &gt; · {account.host}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEditedAccount(account);
                      setAccountEditorOpen(true);
                    }}
                  >
                    Edit / rotate token
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${account.label}`}
                    onClick={() =>
                      void overleafClient
                        .removeAccount(environmentId, account.accountId)
                        .then(refresh)
                        .catch((error) =>
                          toastManager.add({
                            type: "error",
                            title: "Could not remove account",
                            description: errorMessage(error),
                          }),
                        )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))}
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <ConnectionWizard
        open={connectOpen}
        environmentId={environmentId}
        workspaceRoot={workspaceRoot}
        projectName={projectName}
        accounts={overview?.accounts ?? []}
        operation={connectionDraftOperation}
        onOpenChange={setConnectOpen}
        onStarted={track}
        onCompleted={(next) => {
          track(next);
          void refresh();
        }}
        onAddAccount={() => {
          setEditedAccount(null);
          setAccountEditorOpen(true);
        }}
      />
      <AccountEditor
        open={accountEditorOpen}
        environmentId={environmentId}
        account={editedAccount}
        onOpenChange={setAccountEditorOpen}
        onSaved={() => void refresh()}
      />
      <ConnectionSettingsDialog
        open={connectionEditorOpen}
        environmentId={environmentId}
        connection={editedConnection}
        onOpenChange={setConnectionEditorOpen}
        onSaved={() => void refresh()}
      />
      <OperationDialog
        environmentId={environmentId}
        operation={attentionOperation}
        onChanged={track}
        onClose={() => setOperation(null)}
      />
    </>
  );
}
