import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronDown,
  CopyIcon,
  EllipsisIcon,
  LoaderCircle,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  ComputeLanguageId,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  ComputeToolkitId,
  ComputeManagedToolkitChange,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { computeScientPart } from "./computeInstallationSettingsModel";

export interface ComputeManagedRuntimeFailureView {
  readonly summary: string;
  readonly detail: string;
  readonly retryAction: ComputeManagedRuntimeAction | null;
}

export interface ComputeManagedRuntimeProvisionOptions {
  readonly toolkitChange?: ComputeManagedToolkitChange;
  readonly toolkitIds?: ReadonlyArray<ComputeToolkitId>;
  readonly selectionAfterInstall?: "managed" | "existing";
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

// SQL runs DuckDB in Scient-managed Python; other kernel languages manage a kernel package.
const usesManagedPython = (languageId: string) => languageId === "python" || languageId === "sql";

function fallbackManagedRuntimeFailure(
  languageId: string,
  detail: string,
  retryAction: ComputeManagedRuntimeAction | null,
  resolve: MessageResolver = m,
): ComputeManagedRuntimeFailureView {
  return {
    // A refused removal already says what to do, and nothing was being set up.
    summary:
      retryAction === "remove"
        ? detail
        : languageId === "matlab"
          ? resolve(msg("MATLAB connection failed"))
          : usesManagedPython(languageId)
            ? resolve(msg("Python setup failed"))
            : resolve(msg("Kernel setup failed")),
    detail,
    retryAction,
  };
}

export function managedRuntimeOperationLabel(
  status: ComputeManagedRuntimeStatus,
  languageId?: ComputeLanguageId,
  resolve: MessageResolver = m,
): string | null {
  const operation = status.operation;
  if (!operation) return null;
  if (languageId === "matlab") {
    return resolve(
      operation.phase === "removing"
        ? msg("Removing MATLAB connection…")
        : msg("Preparing MATLAB connection…"),
    );
  }
  if (languageId !== undefined && !usesManagedPython(languageId)) {
    const name = status.displayName;
    if (operation.phase === "removing")
      return resolve(name ? msg("Removing {name}…", { name }) : msg("Removing kernel…"));
    return resolve(name ? msg("Installing {name}…", { name }) : msg("Installing kernel…"));
  }
  switch (operation.phase) {
    case "downloading": {
      if (operation.downloadedBytes === null || operation.totalBytes === null)
        return resolve(msg("Downloading the verified installer…"));
      const downloaded = Math.max(0.1, operation.downloadedBytes / (1024 * 1024)).toFixed(1);
      const total = Math.max(0.1, operation.totalBytes / (1024 * 1024)).toFixed(1);
      return resolve(
        msg("Downloading the verified installer · {downloaded} of {total} MB", {
          downloaded,
          total,
        }),
      );
    }
    case "installing-python":
      return resolve(msg("Installing private Python…"));
    case "installing-packages":
      return resolve(
        status.displayName
          ? msg("Preparing the connection helper…")
          : msg("Installing the locked scientific packages…"),
      );
    case "verifying":
      return resolve(
        status.displayName
          ? msg("Checking the connection helper…")
          : msg("Verifying Python, Jupyter, data, and figures…"),
      );
    case "removing":
      return status.displayName
        ? resolve(msg("Removing {name}…", { name: status.displayName }))
        : resolve(msg("Removing Scient-managed Python…"));
  }
}

export function useComputeManagedRuntime(input: {
  environmentId: EnvironmentId | null;
  languageId: ComputeLanguageId;
  initialStatus: ComputeManagedRuntimeStatus | null;
}) {
  const messages = useMessages();
  const manage = useAtomCommand(computeEnvironment.manageRuntime, { reportFailure: false });
  const cancelCommand = useAtomCommand(computeEnvironment.cancelManagedRuntime, {
    reportFailure: false,
  });
  // First-time file setup has no inventory status yet. Subscribe anyway so
  // Set up Python / Connect MATLAB can show progress on the file, not only in Settings.
  const hasManagedPart = computeScientPart(input.languageId) !== null;
  const queried = useEnvironmentQuery(
    input.environmentId && hasManagedPart
      ? computeEnvironment.managedRuntime({
          environmentId: input.environmentId,
          input: { languageId: input.languageId },
        })
      : null,
  );
  const scopeKey = `${input.environmentId ?? ""}\u0000${input.languageId}`;
  // The query hook uses null for both initial loading and successful absence.
  // Only a successful empty response may supersede inventory or a command receipt.
  const querySnapshot = queried.data ?? (queried.isSuccess ? null : undefined);
  const [commandState, setCommandState] = useState<{
    readonly scopeKey: string;
    readonly status: ComputeManagedRuntimeStatus;
    readonly querySnapshot: ComputeManagedRuntimeStatus | null | undefined;
  } | null>(null);
  const candidateCommandStatus = commandState?.scopeKey === scopeKey ? commandState.status : null;
  const commandStatus = reconcileManagedRuntimeCommandSnapshot({
    command: candidateCommandStatus,
    querySnapshot: commandState?.scopeKey === scopeKey ? commandState.querySnapshot : undefined,
    currentQuery: querySnapshot,
  });
  // Once superseded, a receipt must not reappear if the server later returns
  // to its pre-command state (for example after cancellation or removal).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles the optimistic command receipt with newer server truth from the status query
  useEffect(() => {
    if (candidateCommandStatus === null || commandStatus !== null) return;
    // This synchronizes an optimistic command receipt with newer server truth.
    // oxlint-disable-next-line react/set-state-in-effect
    setCommandState((current) =>
      current?.scopeKey === scopeKey && current.status === candidateCommandStatus ? null : current,
    );
  }, [candidateCommandStatus, commandStatus, scopeKey]);
  const status =
    commandStatus ?? (querySnapshot === undefined ? input.initialStatus : querySnapshot);
  const [pending, setPending] = useState(false);
  const [localFailureState, setLocalFailureState] = useState<{
    readonly scopeKey: string;
    readonly failure: ComputeManagedRuntimeFailureView;
  } | null>(null);
  const localFailure = localFailureState?.scopeKey === scopeKey ? localFailureState.failure : null;
  const inFlight = useRef(false);
  const pendingCommands = useRef(0);
  const [cancellationKey, setCancellationKey] = useState<string | null>(null);
  const cancellationRequest = useRef<string | null>(null);
  const operationKey = status?.operation
    ? JSON.stringify([scopeKey, status.operation.operationId])
    : null;
  const cancelling = operationKey !== null && cancellationKey === operationKey;
  const unresolved =
    hasManagedPart && querySnapshot === undefined && queried.error === null && status === null;
  const act = async (
    action: ComputeManagedRuntimeAction,
    options?: ComputeManagedRuntimeProvisionOptions,
  ): Promise<boolean> => {
    const environmentId = input.environmentId;
    const individual = options?.toolkitChange !== undefined;
    const selection = action === "use-managed" || action === "use-existing";
    if (!environmentId || unresolved) return false;
    if (individual) {
      // Older servers do not understand this command; never let them interpret it
      // as an update of the complete environment.
      if (status?.toolkitChanges === undefined || status.operation?.action === "remove")
        return false;
    } else if (
      selection ? status?.operation?.action === "remove" : inFlight.current || status?.operation
    )
      return false;
    // The shared runtime command scheduler already serializes these short RPCs.
    // Count requests here instead of dropping clicks or adding another queue.
    pendingCommands.current++;
    inFlight.current = true;
    setPending(true);
    setLocalFailureState(null);
    // Cancelling a running Toolkit also stops its build. Keep that build's
    // cleanup feedback when the server removes the Toolkit row from its queue.
    const cancelledBuild =
      options?.toolkitChange?.action === "cancel" &&
      status?.toolkitChanges?.some(
        (entry) =>
          entry.toolkitId === options.toolkitChange?.toolkitId && entry.state === "running",
      )
        ? operationKey
        : null;
    if (cancelledBuild !== null) {
      cancellationRequest.current = cancelledBuild;
      setCancellationKey(cancelledBuild);
    }
    return await (async () => {
      const result = await manage({
        environmentId: environmentId,
        input: {
          languageId: input.languageId,
          action,
          ...(options?.toolkitChange === undefined ? {} : { toolkitChange: options.toolkitChange }),
          ...(options?.toolkitIds === undefined ? {} : { toolkitIds: options.toolkitIds }),
          ...(options?.selectionAfterInstall === undefined
            ? {}
            : { selectionAfterInstall: options.selectionAfterInstall }),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value) {
        setCommandState({
          scopeKey,
          status: result.value,
          querySnapshot,
        });
      }
      return true;
    })()
      .catch(async (cause) => {
        if (cancelledBuild !== null) {
          if (cancellationRequest.current === cancelledBuild) cancellationRequest.current = null;
          setCancellationKey((current) => (current === cancelledBuild ? null : current));
        }
        const detail =
          cause instanceof Error
            ? cause.message
            : messages(msg("The installation could not be managed."));
        setLocalFailureState({
          scopeKey,
          failure: fallbackManagedRuntimeFailure(input.languageId, detail, action, messages),
        });
        return false;
      })
      .finally(() => {
        pendingCommands.current--;
        inFlight.current = pendingCommands.current > 0;
        setPending(inFlight.current);
      });
  };
  const cancel = async () => {
    const environmentId = input.environmentId;
    if (!environmentId || operationKey === null || cancellationRequest.current === operationKey)
      return;
    // Acknowledgement is not completion: keep feedback tied to this operation
    // until server truth removes it. The ref also guards clicks before React renders.
    cancellationRequest.current = operationKey;
    setCancellationKey(operationKey);
    setLocalFailureState(null);
    return await (async () => {
      const result = await cancelCommand({
        environmentId: environmentId,
        input: { languageId: input.languageId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value) setCommandState({ scopeKey, status: result.value, querySnapshot });
    })().catch(async (cause) => {
      if (cancellationRequest.current === operationKey) cancellationRequest.current = null;
      setCancellationKey((current) => (current === operationKey ? null : current));
      const detail =
        cause instanceof Error ? cause.message : messages(msg("Setup could not be cancelled."));
      setLocalFailureState({
        scopeKey,
        failure: { summary: messages(msg("Cancellation failed")), detail, retryAction: null },
      });
    });
  };
  const statusFailure =
    status?.failure === undefined || status.failure === null
      ? status?.failureMessage
        ? fallbackManagedRuntimeFailure(
            input.languageId,
            status.failureMessage,
            status.installed ? "repair" : "install",
            messages,
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
      : {
          summary:
            input.languageId === "matlab"
              ? messages(msg("MATLAB status unavailable"))
              : usesManagedPython(input.languageId)
                ? messages(msg("Python status unavailable"))
                : messages(msg("Kernel status unavailable")),
          detail: queried.error,
          retryAction: null,
        };
  return {
    languageId: input.languageId,
    status,
    cancelling,
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
  showFailure = true,
  showProgress = true,
  onRetry,
}: {
  runtime: ComputeManagedRuntimeController;
  variant?: "block" | "toolbar";
  /** A file can use a healthy runtime despite an unrelated setup/maintenance failure. */
  showFailure?: boolean;
  /** A row may own its progress inline while keeping errors below the row. */
  showProgress?: boolean;
  onRetry?: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const progress =
    showProgress &&
    runtime.status &&
    (runtime.cancelling
      ? gt("Cancelling…")
      : managedRuntimeOperationLabel(runtime.status, runtime.languageId, messages));
  // While something is being done about a failure, it is no longer the news.
  const failure = showFailure && !progress ? runtime.failure : null;
  // Removal always stays behind its confirmation dialog, including retries.
  const retryAction = failure?.retryAction === "remove" ? null : (failure?.retryAction ?? null);
  const retry =
    onRetry ??
    (retryAction
      ? () => {
          void runtime.act(retryAction);
        }
      : undefined);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("runtime error"),
  });
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
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={runtime.cancelling}
                onClick={() => void runtime.cancel()}
              >
                <T>Cancel</T>
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
                    className="min-w-0 truncate whitespace-nowrap text-left text-xs text-destructive underline-offset-2 hover:underline"
                    role="alert"
                    onClick={retry}
                  />
                }
              >
                {retryAction === "repair"
                  ? gt("Repair", { $context: "verb" })
                  : retryAction === "install"
                    ? gt("Install")
                    : headline}
              </TooltipTrigger>
              <TooltipPopup>{failure.detail}</TooltipPopup>
            </Tooltip>
            {retry === undefined ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-5 shrink-0"
                      aria-label={gt("Copy error")}
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
                <TooltipPopup>
                  <T>Copy the full error</T>
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {retry !== undefined || failure.detail === failure.summary ? null : (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button size="icon-xs" variant="ghost-muted" aria-label={gt("Error details")} />
                  }
                >
                  <ChevronDown className="size-3" aria-hidden />
                </PopoverTrigger>
                <PopoverPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]" padding="tight">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">
                    {failure.detail}
                  </pre>
                </PopoverPopup>
              </Popover>
            )}
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
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={runtime.cancelling}
              onClick={() => void runtime.cancel()}
            >
              <T>Cancel</T>
            </Button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="flex min-w-0 items-center gap-1 text-destructive" role="alert">
          <span className="min-w-0 break-words">{failure.summary}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 shrink-0"
                  aria-label={gt("Copy error")}
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
            <TooltipPopup>
              <T>Copy the full error</T>
            </TooltipPopup>
          </Tooltip>
          {failure.detail === failure.summary ? null : (
            <details className="min-w-0">
              <summary className="w-fit cursor-pointer list-none text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                <T>Details</T>
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-destructive">
                {failure.detail}
              </pre>
            </details>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ManagedRuntimeMaintenanceMenu({
  runtime,
  connection = false,
  kernel,
  canProvision = true,
  disabled = false,
  omitAction = null,
  connectionNeedsRetarget = false,
  installationActions,
  className,
}: {
  runtime: ComputeManagedRuntimeController;
  connection?: boolean;
  /** A private Jupyter kernel package, such as IRkernel. */
  kernel?: string;
  canProvision?: boolean;
  disabled?: boolean;
  omitAction?: ComputeManagedRuntimeAction | null;
  connectionNeedsRetarget?: boolean;
  installationActions?: ReactNode;
  className?: string;
}) {
  const gt = useGT();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const status = runtime.status;
  if (!status?.installed) return null;
  const displayName = connection
    ? gt("MATLAB connection helper")
    : (kernel ?? gt("Scient-managed Python"));
  const busy = disabled || runtime.busy;
  const connectionAction =
    status.selection === "managed"
      ? "use-existing"
      : connectionNeedsRetarget
        ? "repair"
        : "use-managed";
  const connectionLabel =
    status.selection === "managed"
      ? gt("Use existing MATLAB Engine setup")
      : connectionNeedsRetarget
        ? gt("Set up Scient connection")
        : gt("Use Scient connection");
  const showRepair = omitAction !== "repair";
  const hasNonDestructiveAction = connection || showRepair;

  return (
    <div className={cn("flex items-center", className)} data-compute-maintenance>
      <Menu>
        <MenuTrigger
          render={
            <Button
              ref={menuAnchor}
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              disabled={busy}
              aria-label={
                connection
                  ? gt("More MATLAB connection actions")
                  : kernel
                    ? gt("More {name} actions", { name: kernel })
                    : gt("More Python runtime actions")
              }
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-28">
          {installationActions}
          {installationActions ? <MenuSeparator /> : null}
          {connection ? (
            <MenuItem
              disabled={busy || !canProvision}
              onClick={() => void runtime.act(connectionAction)}
            >
              {connectionLabel}
            </MenuItem>
          ) : null}
          {showRepair ? (
            <MenuItem
              aria-label={
                connection
                  ? gt("Rebuild MATLAB connection")
                  : kernel
                    ? gt("Rebuild {name}", { name: kernel })
                    : gt("Rebuild managed Python")
              }
              disabled={busy || !canProvision}
              onClick={() => void runtime.act("repair")}
            >
              <Wrench /> <T>Rebuild</T>
            </MenuItem>
          ) : null}
          {hasNonDestructiveAction ? <MenuSeparator /> : null}
          <MenuItem
            aria-label={
              connection
                ? gt("Remove MATLAB connection helper")
                : kernel
                  ? gt("Remove {name}", { name: kernel })
                  : gt("Remove managed Python")
            }
            variant="destructive"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 /> <T>Remove</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
      <ContextualConfirmation
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        anchor={menuAnchor}
        title={gt("Remove {name}?", { name: displayName })}
        description={
          connection
            ? gt(
                "This removes Scient’s connection helper. Your MATLAB installation and license are untouched.",
              )
            : kernel
              ? gt(
                  "This removes Scient’s private {name}. Your installation and its packages are untouched.",
                  { name: kernel },
                )
              : gt(
                  "This removes Scient’s private Python environment. System installations and project environments are untouched.",
                )
        }
        confirmLabel={gt("Remove")}
        destructive
        busy={busy}
        onConfirm={() => void runtime.act("remove")}
      />
    </div>
  );
}
