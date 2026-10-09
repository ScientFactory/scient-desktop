import {
  type EnvironmentId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeOperation,
  type ProviderRuntimePlan,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  DownloadIcon,
  LoaderIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  currentOptimisticProviderValue,
  isManagedRuntimeActionDurablySettled,
  type OptimisticProviderValue,
} from "./optimisticProviderValue";
import { isRuntimePlanStale } from "./isRuntimePlanStale";
import { ProviderRuntimeDiagnosticsDetails } from "./ProviderRuntimeDiagnostics";
import {
  cancelRuntimeActionLabel,
  isActiveProviderRuntimeOperation,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";

type PendingAction = "plan" | "start" | "cancel" | null;

const RUNTIME_ACTION_VERBS = {
  install: "Install",
  update: "Update",
  repair: "Repair",
  remove: "Remove",
} satisfies Record<ProviderManagedRuntimeAction, string>;
type StartedRuntimeOperation = {
  readonly action: ProviderManagedRuntimeAction;
  readonly operationId: ProviderRuntimeOperation["operationId"];
};
type LocalRuntimeFailure =
  | {
      readonly kind: "plan";
      readonly action: ProviderManagedRuntimeAction;
      readonly message: string;
    }
  | {
      readonly kind: "start";
      readonly action: ProviderManagedRuntimeAction;
      readonly operationId: ProviderRuntimeOperation["operationId"] | null;
      readonly message: string;
    }
  | {
      readonly kind: "operation";
      readonly operationId: ProviderRuntimeOperation["operationId"];
      readonly message: string;
    };

function runtimeFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ProviderRuntimeSummary | undefined {
  return providers.find((provider) => provider.instanceId === instanceId)?.connection?.runtime;
}

function localRuntimeFailureMessage(
  failure: LocalRuntimeFailure | null,
  runtime: ProviderRuntimeSummary,
): string | null {
  if (!failure) return null;
  if (failure.kind === "plan") {
    return !isActiveProviderRuntimeOperation(runtime.operation) &&
      runtime.actions.includes(failure.action)
      ? failure.message
      : null;
  }
  if (failure.kind === "start") {
    return runtime.actions.includes(failure.action) &&
      (runtime.operation?.operationId ?? null) === failure.operationId
      ? failure.message
      : null;
  }
  const operation = runtime.operation;
  return operation?.operationId === failure.operationId &&
    isActiveProviderRuntimeOperation(operation)
    ? failure.message
    : null;
}

export function resolveProviderRuntimeForPresentation(
  serverRuntime: ProviderRuntimeSummary | undefined,
  localRuntime: ProviderRuntimeSummary | null,
): ProviderRuntimeSummary | null | undefined {
  if (!serverRuntime) return localRuntime;
  if (!localRuntime) return serverRuntime;
  if (serverRuntime.operation?.operationId === localRuntime.operation?.operationId) {
    return serverRuntime;
  }
  const localOperation = localRuntime.operation;
  if (!localOperation || !isActiveProviderRuntimeOperation(localOperation)) {
    return serverRuntime;
  }
  if (isManagedRuntimeActionDurablySettled(localOperation.action, serverRuntime)) {
    return serverRuntime;
  }
  return localRuntime;
}

function runtimeSourceLabel(
  runtime: ProviderRuntimeSummary,
  driver: ServerProvider["driver"],
): string {
  if (driver === "cursor") {
    if (runtime.source === "scient_managed") return "Cursor CLI managed by Scient";
    if (runtime.source === "system") return "System Cursor CLI";
    if (runtime.source === "custom") return "Custom Cursor CLI";
    if (runtime.source === "missing") return "Cursor CLI not installed";
    return "Cursor CLI status unavailable";
  }
  if (runtime.source === "registry") return "ACP Registry installation managed by Scient";
  if (runtime.source === "scient_managed") return "Managed by Scient";
  if (runtime.source === "system") return "System installation";
  if (runtime.source === "custom") return "Custom installation";
  if (runtime.source === "missing") return "Provider tool required";
  return "Provider tool status unavailable";
}

export function ProviderRuntimeSection(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly compact?: boolean;
  /**
   * `row` renders as a row of the surrounding settings section: no frame of
   * its own, status on the left and actions on the right. `card` (default)
   * frames itself for dialogs. `compact` wins over both.
   */
  readonly presentation?: "card" | "row";
  readonly disabled?: boolean;
  /** An explicit action clicked before opening this surface, never inferred from provider state. */
  readonly initialAction?: ProviderManagedRuntimeAction | undefined;
  readonly onActionSucceeded?: (action: ProviderManagedRuntimeAction) => void;
  readonly onPlanOpenChange?: (open: boolean) => void;
}) {
  const { environmentId, provider, onActionSucceeded, onPlanOpenChange } = props;
  const runtimeDisplayName =
    provider.driver === "cursor" ? `${props.displayName} CLI` : props.displayName;
  const planRuntime = useAtomCommand(serverEnvironment.planProviderRuntime, {
    reportFailure: false,
  });
  const startRuntime = useAtomCommand(serverEnvironment.startProviderRuntime, {
    reportFailure: false,
  });
  const cancelRuntime = useAtomCommand(serverEnvironment.cancelProviderRuntime, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<PendingAction>(() =>
    props.initialAction ? "plan" : null,
  );
  const [preparedPlan, setPreparedPlan] = useState<ProviderRuntimePlan | null>(null);
  const [localRuntimeSnapshot, setLocalRuntimeSnapshot] =
    useState<OptimisticProviderValue<ProviderRuntimeSummary> | null>(null);
  const [localFailure, setLocalFailure] = useState<LocalRuntimeFailure | null>(null);
  const [startedOperation, setStartedOperation] = useState<StartedRuntimeOperation | null>(null);
  const requestingRuntimeRef = useRef(false);
  const startingRuntimeRef = useRef(false);
  const providerInstanceIdRef = useRef(provider.instanceId);
  const initialPlanRequestRef = useRef<string | null>(null);
  const reportedOperationIdRef = useRef<ProviderRuntimeOperation["operationId"] | null>(null);

  useEffect(() => {
    if (providerInstanceIdRef.current === provider.instanceId) return;
    providerInstanceIdRef.current = provider.instanceId;
    setPendingAction(null);
    setPreparedPlan(null);
    setLocalRuntimeSnapshot(null);
    setLocalFailure(null);
    setStartedOperation(null);
    initialPlanRequestRef.current = null;
    reportedOperationIdRef.current = null;
  }, [provider.instanceId]);

  const serverRuntime = provider.connection?.runtime;
  // A command result bridges the transport delay only while the provider prop
  // is still the exact snapshot from which that command started. Once the
  // provider-status stream replaces it, the canonical server snapshot wins.
  const localRuntime = currentOptimisticProviderValue(localRuntimeSnapshot, provider);
  const serverOperation = serverRuntime?.operation;
  const startedOperationId = startedOperation?.operationId;
  const startedOperationAction = startedOperation?.action;

  useEffect(() => {
    if (!startedOperationId || serverOperation?.operationId !== startedOperationId) return;
    if (isActiveProviderRuntimeOperation(serverOperation)) return;

    setStartedOperation(null);
    if (
      serverOperation.status === "succeeded" &&
      reportedOperationIdRef.current !== serverOperation.operationId
    ) {
      reportedOperationIdRef.current = serverOperation.operationId;
      if (startedOperationAction) onActionSucceeded?.(startedOperationAction);
    }
  }, [onActionSucceeded, serverOperation, startedOperationAction, startedOperationId]);
  const runtime = useMemo(
    () => resolveProviderRuntimeForPresentation(serverRuntime, localRuntime),
    [localRuntime, serverRuntime],
  );

  const operation = runtime?.operation ?? null;
  const runtimeActions = runtime?.actions;
  const activeOperation = isActiveProviderRuntimeOperation(operation) ? operation : null;
  const plan =
    !activeOperation && preparedPlan?.action === "remove" && runtimeActions?.includes("remove")
      ? preparedPlan
      : null;
  const localError = runtime ? localRuntimeFailureMessage(localFailure, runtime) : null;
  const progress =
    activeOperation?.downloadedBytes !== undefined && activeOperation.totalBytes !== undefined
      ? Math.min(
          100,
          Math.round((activeOperation.downloadedBytes / activeOperation.totalBytes) * 100),
        )
      : null;
  const isWorking = pendingAction !== null || props.disabled === true;
  const row = !props.compact && props.presentation === "row";
  /** Padding of a settings row; a card frames itself instead. */
  const frame = (card: string) => (row ? "px-3 py-3 sm:px-4" : card);

  const startPlan = useCallback(
    async (nextPlan: ProviderRuntimePlan) => {
      if (startingRuntimeRef.current || !runtimeActions?.includes(nextPlan.action)) return;
      startingRuntimeRef.current = true;
      try {
        const operationId = operation?.operationId ?? null;
        setLocalFailure(null);
        setPendingAction("start");
        let result = await startRuntime({
          environmentId,
          input: {
            instanceId: provider.instanceId,
            action: nextPlan.action,
            catalogRevision: nextPlan.catalogRevision,
          },
        });
        if (
          nextPlan.action !== "remove" &&
          result._tag === "Failure" &&
          !isAtomCommandInterrupted(result) &&
          isRuntimePlanStale(squashAtomCommandFailure(result))
        ) {
          // Refresh once; the explicit action already chose Scient's managed release.
          const replanned = await planRuntime({
            environmentId,
            input: { instanceId: provider.instanceId, action: nextPlan.action },
          });
          result =
            replanned._tag === "Failure"
              ? AsyncResult.failure(replanned.cause)
              : await startRuntime({
                  environmentId,
                  input: {
                    instanceId: provider.instanceId,
                    action: replanned.value.action,
                    catalogRevision: replanned.value.catalogRevision,
                  },
                });
        }
        if (result._tag === "Failure") {
          const failure = isAtomCommandInterrupted(result)
            ? null
            : squashAtomCommandFailure(result);
          setPendingAction(null);
          if (failure) {
            setLocalFailure({
              kind: "start",
              action: nextPlan.action,
              operationId,
              message: providerLifecycleFailureMessage(
                failure,
                `Scient could not start the ${runtimeDisplayName} runtime operation.`,
              ),
            });
          }
          return;
        }
        const nextRuntime = runtimeFromResult(result.value.providers, provider.instanceId);
        const nextOperation = nextRuntime?.operation;
        if (nextOperation?.action === nextPlan.action) {
          if (isActiveProviderRuntimeOperation(nextOperation)) {
            setStartedOperation({
              action: nextPlan.action,
              operationId: nextOperation.operationId,
            });
          } else if (
            nextOperation.status === "succeeded" &&
            reportedOperationIdRef.current !== nextOperation.operationId
          ) {
            reportedOperationIdRef.current = nextOperation.operationId;
            onActionSucceeded?.(nextPlan.action);
          }
        }
        setLocalRuntimeSnapshot(
          nextRuntime ? { baseProvider: provider, value: nextRuntime } : null,
        );
        setPreparedPlan(null);
        onPlanOpenChange?.(false);
        setPendingAction(null);
      } finally {
        startingRuntimeRef.current = false;
      }
    },
    [
      planRuntime,
      startRuntime,
      runtimeDisplayName,
      environmentId,
      onActionSucceeded,
      onPlanOpenChange,
      provider,
      operation?.operationId,
      runtimeActions,
    ],
  );

  const requestPlan = useCallback(
    async (action: ProviderManagedRuntimeAction) => {
      if (requestingRuntimeRef.current) return;
      requestingRuntimeRef.current = true;
      try {
        if (isActiveProviderRuntimeOperation(operation) || !runtimeActions?.includes(action)) {
          setPendingAction(null);
          setPreparedPlan(null);
          setLocalFailure(null);
          onPlanOpenChange?.(false);
          return;
        }
        const needsDecision = action === "remove";
        setLocalFailure(null);
        setPendingAction("plan");
        if (needsDecision) onPlanOpenChange?.(true);
        const result = await planRuntime({
          environmentId,
          input: { instanceId: provider.instanceId, action },
        });
        if (result._tag === "Failure") {
          setPendingAction(null);
          onPlanOpenChange?.(false);
          if (!isAtomCommandInterrupted(result)) {
            setLocalFailure({
              kind: "plan",
              action,
              message: providerLifecycleFailureMessage(
                squashAtomCommandFailure(result),
                `Scient could not prepare the ${runtimeDisplayName} setup plan.`,
              ),
            });
          }
          return;
        }
        if (!needsDecision) {
          await startPlan(result.value);
          return;
        }
        setPendingAction(null);
        setPreparedPlan(result.value);
      } finally {
        requestingRuntimeRef.current = false;
      }
    },
    [
      planRuntime,
      runtimeDisplayName,
      environmentId,
      onPlanOpenChange,
      provider.instanceId,
      runtimeActions,
      operation,
      startPlan,
    ],
  );

  useEffect(() => {
    if (!props.initialAction || !runtimeActions) return;
    const requestKey = `${provider.instanceId}:${props.initialAction}`;
    if (initialPlanRequestRef.current === requestKey) return;
    initialPlanRequestRef.current = requestKey;
    void requestPlan(props.initialAction);
  }, [props.initialAction, provider.instanceId, requestPlan, runtimeActions]);

  useEffect(() => {
    if (!preparedPlan || plan) return;
    setPreparedPlan(null);
    onPlanOpenChange?.(false);
  }, [plan, preparedPlan, onPlanOpenChange]);

  useEffect(() => {
    if (!localFailure || localError) return;
    setLocalFailure(null);
  }, [localError, localFailure]);

  if (!runtime) return null;

  const start = async () => {
    if (!plan) return;
    await startPlan(plan);
  };

  const cancel = async () => {
    if (!activeOperation) return;
    setLocalFailure(null);
    setPendingAction("cancel");
    const result = await cancelRuntime({
      environmentId,
      input: {
        instanceId: provider.instanceId,
        operationId: activeOperation.operationId,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalFailure({
          kind: "operation",
          operationId: activeOperation.operationId,
          message: providerLifecycleFailureMessage(
            squashAtomCommandFailure(result),
            `Scient could not cancel the ${runtimeDisplayName} runtime operation.`,
          ),
        });
      }
      return;
    }
    const nextRuntime = runtimeFromResult(result.value.providers, provider.instanceId);
    setLocalRuntimeSnapshot(nextRuntime ? { baseProvider: provider, value: nextRuntime } : null);
  };

  if (activeOperation) {
    return (
      <div
        className={
          props.compact
            ? "space-y-4 py-1"
            : cn("space-y-3", frame("rounded-lg border bg-muted/20 p-3"))
        }
      >
        <div className="flex items-start gap-3">
          <LoaderIcon className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{activeOperation.message}</p>
            {!props.compact ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                You can keep using Scient. The previous working runtime remains available until the
                new copy is verified.
              </p>
            ) : null}
          </div>
        </div>
        {!props.compact && progress !== null ? (
          <div
            className="space-y-1"
            role="progressbar"
            aria-label="Provider download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-right text-[11px] tabular-nums text-muted-foreground">{progress}%</p>
          </div>
        ) : null}
        {localError ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {localError}
          </p>
        ) : null}
        <div className={props.compact ? "flex items-center justify-end gap-3 pt-1" : "flex"}>
          {props.compact && progress !== null ? (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              aria-label={`Download progress ${progress}%`}
            >
              {progress}%
            </span>
          ) : null}
          <Button
            aria-label={cancelRuntimeActionLabel(runtimeDisplayName, activeOperation.action)}
            type="button"
            size="sm"
            variant={props.compact ? "ghost-destructive-action" : "destructive-outline"}
            disabled={isWorking}
            onClick={() => void cancel()}
          >
            {pendingAction === "cancel" ? <LoaderIcon className="animate-spin" /> : <XIcon />}
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if ((pendingAction === "plan" || pendingAction === "start") && props.initialAction && !plan) {
    return (
      <div
        className={
          props.compact
            ? "flex items-start gap-3 py-1"
            : cn("flex items-start gap-3", frame("rounded-lg border bg-muted/20 p-3"))
        }
      >
        <LoaderIcon className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0">
          <p role="status" className="text-sm font-medium text-foreground">
            Preparing {runtimeDisplayName}…
          </p>
        </div>
      </div>
    );
  }

  if (plan) {
    return (
      <div
        className={
          props.compact
            ? "space-y-3 py-1"
            : cn("space-y-3", frame("rounded-lg border border-primary/20 bg-primary/[0.03] p-3"))
        }
      >
        <div className="flex items-start gap-3">
          <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Remove {runtimeDisplayName}?</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Only Scient’s managed copy will be removed. Your account and other{" "}
              {runtimeDisplayName} installations stay unchanged.
            </p>
          </div>
        </div>
        {localError ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {localError}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost-muted"
            disabled={isWorking}
            onClick={() => {
              setPreparedPlan(null);
              onPlanOpenChange?.(false);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost-destructive-action"
            disabled={isWorking}
            onClick={() => void start()}
          >
            {pendingAction === "start" ? <LoaderIcon className="animate-spin" /> : <Trash2Icon />}
            Remove
          </Button>
        </div>
      </div>
    );
  }

  const terminalOperation =
    operation && !isActiveProviderRuntimeOperation(operation) ? operation : null;
  const providerRuntimeError = needsManagedRuntimeRecovery(provider) ? provider.message : null;
  const statusMessage =
    (terminalOperation?.status === "failed" ? terminalOperation.message : null) ??
    providerRuntimeError ??
    (runtime.source === "missing" &&
    !(provider.driver === "pi" && runtime.actions.includes("install"))
      ? runtime.message
      : null);
  const statusIcon =
    runtime.source === "missing" ||
    terminalOperation?.status === "failed" ||
    providerRuntimeError ? (
      <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
    ) : (
      <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
    );
  const presentsCompactUpdateSeparately = props.compact && runtime.actions.includes("update");
  const trailingActions: ReadonlyArray<ProviderManagedRuntimeAction> =
    presentsCompactUpdateSeparately
      ? runtime.actions.filter((action) => action !== "update")
      : runtime.actions;

  return (
    <div
      className={
        props.compact
          ? "space-y-2 border-b pb-3"
          : row
            ? "@container/runtime-row space-y-2 px-3 py-3 sm:px-4"
            : "space-y-3 rounded-lg border p-3"
      }
    >
      <div
        className={
          props.compact
            ? "grid grid-cols-[minmax(9rem,1fr)_auto] items-center gap-x-3 gap-y-2"
            : row
              ? "flex flex-col gap-3 @min-[32rem]/runtime-row:grid @min-[32rem]/runtime-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/runtime-row:items-center @min-[32rem]/runtime-row:gap-8"
              : "space-y-3"
        }
      >
        <div className="flex min-w-0 items-start gap-3">
          {statusIcon}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {runtimeSourceLabel(runtime, provider.driver)}
            </p>
            {provider.driver === "cursor" ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Conversations use the bundled Cursor SDK. These controls manage the separate CLI.
              </p>
            ) : null}
            {statusMessage ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {statusMessage}
              </p>
            ) : null}
          </div>
        </div>
        {trailingActions.length > 0 ? (
          <div className={cn("flex flex-wrap justify-end", row ? "gap-2" : "gap-1")}>
            {trailingActions.map((action) => {
              const isSystemManagedSwitch = action === "install" && runtime.source === "system";
              const actionButton = (
                <Button
                  aria-label={
                    isSystemManagedSwitch
                      ? `Use Scient-managed ${runtimeDisplayName}`
                      : `${RUNTIME_ACTION_VERBS[action]} ${runtimeDisplayName}`
                  }
                  key={action}
                  type="button"
                  size={props.compact ? "compact" : "sm"}
                  variant={
                    action === "update" || action === "install"
                      ? "ghost-primary"
                      : props.compact
                        ? action === "remove"
                          ? "ghost-destructive-action"
                          : "ghost-muted"
                        : action === "remove"
                          ? "destructive-outline"
                          : "outline"
                  }
                  disabled={isWorking}
                  onClick={() => void requestPlan(action)}
                >
                  {pendingAction === "plan" || pendingAction === "start" ? (
                    <LoaderIcon className="animate-spin" />
                  ) : action === "install" ? (
                    <DownloadIcon />
                  ) : action === "update" ? (
                    <RefreshCwIcon />
                  ) : action === "remove" ? (
                    <Trash2Icon />
                  ) : (
                    <WrenchIcon />
                  )}
                  {action === "install"
                    ? isSystemManagedSwitch
                      ? "Use Scient-managed"
                      : "Install"
                    : action === "update"
                      ? "Update"
                      : action === "repair"
                        ? "Repair"
                        : "Remove"}
                </Button>
              );
              return isSystemManagedSwitch ? (
                <Tooltip key={action}>
                  <TooltipTrigger render={actionButton} />
                  <TooltipPopup className="max-w-64" side="top">
                    <div className="space-y-0.5 py-0.5">
                      <p className="font-medium text-foreground">
                        Scient-managed {runtimeDisplayName}
                      </p>
                      <p className="leading-relaxed text-muted-foreground">
                        Scient installs and maintains a private copy, including updates and repairs.
                        Your system installation stays unchanged and remains available.
                      </p>
                    </div>
                  </TooltipPopup>
                </Tooltip>
              ) : (
                actionButton
              );
            })}
          </div>
        ) : null}
      </div>
      {localError ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {localError}
        </p>
      ) : null}
      {presentsCompactUpdateSeparately ? (
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="min-w-0 flex-1">
            <ProviderRuntimeDiagnosticsDetails
              displayName={runtimeDisplayName}
              provider={provider}
            />
          </div>
          <Button
            className="shrink-0"
            disabled={isWorking}
            onClick={() => void requestPlan("update")}
            size="compact"
            type="button"
            variant="ghost-primary"
          >
            {pendingAction === "plan" || pendingAction === "start" ? (
              <LoaderIcon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}
            Update
          </Button>
        </div>
      ) : (
        <ProviderRuntimeDiagnosticsDetails displayName={runtimeDisplayName} provider={provider} />
      )}
    </div>
  );
}
