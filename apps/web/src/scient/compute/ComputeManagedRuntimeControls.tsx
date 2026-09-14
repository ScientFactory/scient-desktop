import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDown,
  CopyIcon,
  Download,
  LoaderCircle,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  ComputeLanguageId,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export interface ComputeManagedRuntimeFailureView {
  readonly summary: string;
  readonly detail: string;
  readonly retryAction: ComputeManagedRuntimeAction | null;
}

function sameManagedRuntimeSnapshot(
  left: ComputeManagedRuntimeStatus,
  right: ComputeManagedRuntimeStatus,
): boolean {
  return managedRuntimeSnapshotKey(left) === managedRuntimeSnapshotKey(right);
}

function managedRuntimeSnapshotKey(status: ComputeManagedRuntimeStatus | null | undefined): string {
  if (status === undefined) return "pending";
  if (status === null) return "absent";
  return JSON.stringify(status);
}

/**
 * Keep the immediate command receipt only until a concrete server observation
 * moves beyond the query snapshot that preceded the command. A refetch may
 * temporarily have no data; that is not new server truth.
 */
export function reconcileManagedRuntimeCommandSnapshot(input: {
  readonly command: ComputeManagedRuntimeStatus | null;
  readonly querySnapshot: ComputeManagedRuntimeStatus | null | undefined;
  readonly currentQuery: ComputeManagedRuntimeStatus | null | undefined;
}): ComputeManagedRuntimeStatus | null {
  if (input.command === null) return null;
  if (input.currentQuery === undefined) return input.command;
  if (
    managedRuntimeSnapshotKey(input.querySnapshot) !== managedRuntimeSnapshotKey(input.currentQuery)
  )
    return null;
  return input.currentQuery !== null &&
    sameManagedRuntimeSnapshot(input.command, input.currentQuery)
    ? null
    : input.command;
}

function fallbackManagedRuntimeFailure(
  languageId: string,
  detail: string,
  retryAction: ComputeManagedRuntimeAction | null,
): ComputeManagedRuntimeFailureView {
  return {
    summary: languageId === "matlab" ? "MATLAB connection failed" : "Python setup failed",
    detail,
    retryAction,
  };
}

export function managedRuntimeOperationLabel(status: ComputeManagedRuntimeStatus): string | null {
  const operation = status.operation;
  if (!operation) return null;
  switch (operation.phase) {
    case "downloading": {
      if (operation.downloadedBytes === null || operation.totalBytes === null)
        return "Downloading the verified installer…";
      const downloaded = Math.max(0.1, operation.downloadedBytes / (1024 * 1024)).toFixed(1);
      const total = Math.max(0.1, operation.totalBytes / (1024 * 1024)).toFixed(1);
      return `Downloading the verified installer · ${downloaded} of ${total} MB`;
    }
    case "installing-python":
      return "Installing private Python…";
    case "installing-packages":
      return status.displayName
        ? "Preparing the connection helper…"
        : "Installing the locked scientific packages…";
    case "verifying":
      return status.displayName
        ? "Checking the connection helper…"
        : "Verifying Python, Jupyter, data, and figures…";
    case "removing":
      return `Removing ${status.displayName ?? "Scient-managed Python"}…`;
  }
}

export function useComputeManagedRuntime(input: {
  environmentId: EnvironmentId | null;
  languageId: ComputeLanguageId;
  initialStatus: ComputeManagedRuntimeStatus | null;
  ensureEnabled: () => Promise<boolean>;
}) {
  const manage = useAtomCommand(computeEnvironment.manageRuntime, { reportFailure: false });
  const cancelCommand = useAtomCommand(computeEnvironment.cancelManagedRuntime, {
    reportFailure: false,
  });
  // First-time file setup has no inventory status yet. Subscribe anyway so
  // Set up Python / Connect MATLAB can show progress on the file, not only in Settings.
  const queried = useEnvironmentQuery(
    input.environmentId
      ? computeEnvironment.managedRuntime({
          environmentId: input.environmentId,
          input: { languageId: input.languageId },
        })
      : null,
  );
  const scopeKey = `${input.environmentId ?? ""}\u0000${input.languageId}`;
  const [commandState, setCommandState] = useState<{
    readonly scopeKey: string;
    readonly status: ComputeManagedRuntimeStatus;
    readonly querySnapshot: ComputeManagedRuntimeStatus | null | undefined;
  } | null>(null);
  const candidateCommandStatus = commandState?.scopeKey === scopeKey ? commandState.status : null;
  const commandStatus = reconcileManagedRuntimeCommandSnapshot({
    command: candidateCommandStatus,
    querySnapshot: commandState?.scopeKey === scopeKey ? commandState.querySnapshot : undefined,
    currentQuery: queried.data,
  });
  // Once superseded, a receipt must not reappear if the server later returns
  // to its pre-command state (for example after cancellation or removal).
  useEffect(() => {
    if (candidateCommandStatus === null || commandStatus !== null) return;
    // This synchronizes an optimistic command receipt with newer server truth.
    // oxlint-disable-next-line react/set-state-in-effect
    setCommandState((current) => (current?.scopeKey === scopeKey ? null : current));
  }, [candidateCommandStatus, commandStatus, scopeKey]);
  const status = commandStatus ?? (queried.data === undefined ? input.initialStatus : queried.data);
  const [pending, setPending] = useState(false);
  const [localFailureState, setLocalFailureState] = useState<{
    readonly scopeKey: string;
    readonly failure: ComputeManagedRuntimeFailureView;
  } | null>(null);
  const localFailure = localFailureState?.scopeKey === scopeKey ? localFailureState.failure : null;
  const inFlight = useRef(false);
  const unresolved = queried.data === undefined && queried.error === null && status === null;
  const act = async (action: ComputeManagedRuntimeAction): Promise<boolean> => {
    if (!input.environmentId || inFlight.current || unresolved || status?.operation) return false;
    inFlight.current = true;
    setPending(true);
    setLocalFailureState(null);
    try {
      if ((action === "install" || action === "use-managed") && !(await input.ensureEnabled())) {
        throw new Error("The language could not be enabled. Settings were not saved.");
      }
      const result = await manage({
        environmentId: input.environmentId,
        input: { languageId: input.languageId, action },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value) {
        setCommandState({
          scopeKey,
          status: result.value,
          querySnapshot: queried.data,
        });
      }
      return true;
    } catch (cause) {
      const detail =
        cause instanceof Error ? cause.message : "The installation could not be managed.";
      setLocalFailureState({
        scopeKey,
        failure: fallbackManagedRuntimeFailure(input.languageId, detail, action),
      });
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const cancel = async () => {
    if (!input.environmentId) return;
    const result = await cancelCommand({
      environmentId: input.environmentId,
      input: { languageId: input.languageId },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      const detail = failure instanceof Error ? failure.message : "Setup could not be cancelled.";
      setLocalFailureState({
        scopeKey,
        failure: fallbackManagedRuntimeFailure(input.languageId, detail, null),
      });
    }
  };
  const statusFailure =
    status?.failure === undefined || status.failure === null
      ? status?.failureMessage
        ? fallbackManagedRuntimeFailure(
            input.languageId,
            status.failureMessage,
            status.installed ? "repair" : "install",
          )
        : null
      : {
          summary: status.failure.summary,
          detail: status.failure.detail,
          retryAction: status.failure.action,
        };
  const queryFailure =
    queried.error === null
      ? null
      : fallbackManagedRuntimeFailure(input.languageId, queried.error, null);
  return {
    status,
    busy: pending || unresolved || status?.operation != null,
    failure: localFailure ?? queryFailure ?? statusFailure,
    act,
    cancel,
  };
}

export type ComputeManagedRuntimeController = ReturnType<typeof useComputeManagedRuntime>;

export function ManagedRuntimeNotice({
  runtime,
  variant = "block",
  onRetry,
}: {
  runtime: ComputeManagedRuntimeController;
  variant?: "block" | "toolbar";
  onRetry?: () => void;
}) {
  const progress = runtime.status && managedRuntimeOperationLabel(runtime.status);
  const failure = runtime.failure;
  // Removal always stays behind its confirmation dialog, including retries.
  const retryAction = failure?.retryAction === "remove" ? null : (failure?.retryAction ?? null);
  const retry =
    onRetry ??
    (retryAction
      ? () => {
          void runtime.act(retryAction);
        }
      : undefined);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "runtime error" });
  if (!progress && !failure) return null;
  if (variant === "toolbar") {
    const headline = failure?.summary ?? null;
    return (
      <div
        className="flex min-w-0 items-center gap-0.5 overflow-hidden"
        data-compute-notice="toolbar"
      >
        {progress ? (
          <div className="flex min-w-0 items-center gap-1" role="status">
            <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
            <span className="truncate whitespace-nowrap text-xs text-muted-foreground">
              {progress}
            </span>
            {runtime.status?.operation?.action !== "remove" ? (
              <Button size="xs" variant="ghost-muted" onClick={() => void runtime.cancel()}>
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        {headline && failure ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="min-w-0 truncate whitespace-nowrap text-left text-xs text-destructive"
                    role="alert"
                    onClick={retry}
                  />
                }
              >
                {headline}
              </TooltipTrigger>
              <TooltipPopup>{retry === undefined ? headline : `Retry ${headline}`}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 shrink-0"
                    aria-label="Copy error"
                    onClick={() => copyToClipboard(failure.detail, undefined)}
                  />
                }
              >
                {isCopied ? (
                  <CheckIcon aria-hidden className="size-3" />
                ) : (
                  <CopyIcon aria-hidden className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup>Copy the full error</TooltipPopup>
            </Tooltip>
            <Popover>
              <PopoverTrigger
                render={<Button size="icon-xs" variant="ghost-muted" aria-label="Error details" />}
              >
                <ChevronDown className="size-3" aria-hidden />
              </PopoverTrigger>
              <PopoverPopup
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)]"
                viewportClassName="p-2"
              >
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">
                  {failure.detail}
                </pre>
              </PopoverPopup>
            </Popover>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs" data-compute-notice="block">
      {progress ? (
        <div className="flex flex-wrap items-center gap-1.5" role="status">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          <span className="text-muted-foreground">{progress}</span>
          {runtime.status?.operation?.action !== "remove" ? (
            <Button size="xs" variant="ghost-muted" onClick={() => void runtime.cancel()}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="flex min-w-0 items-center gap-1 text-destructive" role="alert">
          <span className="min-w-0 truncate">{failure.summary}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 shrink-0"
                  aria-label="Copy error"
                  onClick={() => copyToClipboard(failure.detail, undefined)}
                />
              }
            >
              {isCopied ? (
                <CheckIcon aria-hidden className="size-3" />
              ) : (
                <CopyIcon aria-hidden className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup>Copy the full error</TooltipPopup>
          </Tooltip>
          <details className="min-w-0">
            <summary className="w-fit cursor-pointer list-none text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
              Details
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">
              {failure.detail}
            </pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

export function ManagedRuntimeActions({
  runtime,
  connection = false,
  canProvision = true,
  disabled = false,
  maintenanceOnly = false,
  omitAction = null,
  className,
}: {
  runtime: ComputeManagedRuntimeController;
  connection?: boolean;
  canProvision?: boolean;
  disabled?: boolean;
  maintenanceOnly?: boolean;
  omitAction?: ComputeManagedRuntimeAction | null;
  className?: string;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = runtime.status;
  if (!status) return null;
  const displayName = connection ? "MATLAB connection helper" : "Scient-managed Python";
  const busy = disabled || runtime.busy;
  if (maintenanceOnly && !status.installed) return null;
  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-0.5", className)}>
        {!status.installed ? (
          <Button
            size="xs"
            disabled={busy || !canProvision}
            onClick={() => void runtime.act("install")}
          >
            <Download /> {connection ? "Set up connection" : "Set up Python"}
          </Button>
        ) : (
          <>
            {connection ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy || (!canProvision && status.selection !== "managed")}
                onClick={() =>
                  void runtime.act(status.selection === "managed" ? "use-existing" : "use-managed")
                }
              >
                {status.selection === "managed" ? "Use existing host" : "Use helper"}
              </Button>
            ) : null}
            {status.updateAvailable && omitAction !== "update" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !canProvision}
                onClick={() => void runtime.act("update")}
              >
                <Download /> Update
              </Button>
            ) : null}
            {omitAction !== "repair" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy || !canProvision}
                      onClick={() => void runtime.act("repair")}
                    />
                  }
                >
                  <Wrench /> {connection ? "Repair connection" : "Repair"}
                </TooltipTrigger>
                <TooltipPopup>
                  {canProvision
                    ? "Rebuild and verify the Scient-managed setup."
                    : "Select this installation before repairing its connection."}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <ContextualConfirmation
              open={confirmRemove}
              onOpenChange={setConfirmRemove}
              trigger={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy}
                  aria-label={`Remove ${displayName}`}
                >
                  <Trash2 /> {connection ? "Remove helper" : "Remove"}
                </Button>
              }
              title={`Remove ${displayName}?`}
              description={
                connection
                  ? "This removes Scient’s connection helper. Your MATLAB installation and license are untouched."
                  : "This removes Scient’s private Python environment. System installations and project environments are untouched."
              }
              confirmLabel="Remove"
              destructive
              busy={busy}
              onConfirm={() => void runtime.act("remove")}
            />
          </>
        )}
      </div>
    </>
  );
}
