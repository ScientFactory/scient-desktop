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
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/button";
import {
  currentOptimisticProviderValue,
  isManagedRuntimeActionDurablySettled,
  type OptimisticProviderValue,
} from "./optimisticProviderValue";
import { ProviderRuntimeDiagnosticsDetails } from "./ProviderRuntimeDiagnostics";
import { DESTRUCTIVE_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
import {
  isActiveProviderRuntimeOperation,
  needsManagedRuntimeRecovery,
  providerLifecycleFailureMessage,
} from "./providerConnectionPresentation";

type PendingAction = "plan" | "start" | "cancel" | null;
type StartedRuntimeOperation = {
  readonly action: ProviderManagedRuntimeAction;
  readonly operationId: ProviderRuntimeOperation["operationId"];
};

function runtimeFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ProviderRuntimeSummary | undefined {
  return providers.find((provider) => provider.instanceId === instanceId)?.connection?.runtime;
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

function formatDownloadSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function platformLabel(target: string): string {
  const [platform, arch, libc] = target.split("-");
  const platformName = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
  const architecture =
    arch === "arm64" ? (platform === "darwin" ? "Apple silicon" : "ARM64") : "Intel/AMD 64-bit";
  return [platformName, architecture, libc].filter(Boolean).join(" · ");
}

function actionLabel(action: ProviderManagedRuntimeAction, displayName: string): string {
  switch (action) {
    case "install":
      return `Install ${displayName}`;
    case "update":
      return `Update ${displayName}`;
    case "repair":
      return `Repair ${displayName}`;
    case "remove":
      return `Remove managed ${displayName}`;
  }
}

function runtimeSourceLabel(runtime: ProviderRuntimeSummary): string {
  if (runtime.source === "scient_managed") return "Managed by Scient";
  if (runtime.source === "system") return "Using the installation on this computer";
  if (runtime.source === "custom") return "Using your custom installation";
  if (runtime.source === "missing") return "Provider tool required";
  return "Provider tool status unavailable";
}

export function ProviderRuntimeSection(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly initialAction?: ProviderManagedRuntimeAction | undefined;
  readonly onActionSucceeded?: (action: ProviderManagedRuntimeAction) => void;
  readonly onPlanOpenChange?: (open: boolean) => void;
}) {
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
  const [plan, setPlan] = useState<ProviderRuntimePlan | null>(null);
  const [localRuntimeSnapshot, setLocalRuntimeSnapshot] =
    useState<OptimisticProviderValue<ProviderRuntimeSummary> | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [startedOperation, setStartedOperation] = useState<StartedRuntimeOperation | null>(null);
  const providerInstanceIdRef = useRef(props.provider.instanceId);
  const initialPlanRequestRef = useRef<string | null>(null);
  const reportedOperationIdRef = useRef<ProviderRuntimeOperation["operationId"] | null>(null);

  useEffect(() => {
    if (providerInstanceIdRef.current === props.provider.instanceId) return;
    providerInstanceIdRef.current = props.provider.instanceId;
    setPendingAction(null);
    setPlan(null);
    setLocalRuntimeSnapshot(null);
    setLocalError(null);
    setStartedOperation(null);
    initialPlanRequestRef.current = null;
    reportedOperationIdRef.current = null;
  }, [props.provider.instanceId]);

  const serverRuntime = props.provider.connection?.runtime;
  // A command result bridges the transport delay only while the provider prop
  // is still the exact snapshot from which that command started. Once the
  // provider-status stream replaces it, the canonical server snapshot wins.
  const localRuntime = currentOptimisticProviderValue(localRuntimeSnapshot, props.provider);
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
      if (startedOperationAction) props.onActionSucceeded?.(startedOperationAction);
    }
  }, [
    props.onActionSucceeded,
    serverOperation?.operationId,
    serverOperation?.status,
    startedOperationAction,
    startedOperationId,
  ]);
  const runtime = useMemo(
    () => resolveProviderRuntimeForPresentation(serverRuntime, localRuntime),
    [localRuntime, serverRuntime],
  );

  if (!runtime) return null;

  const operation = runtime.operation;
  const activeOperation = isActiveProviderRuntimeOperation(operation) ? operation : null;
  const progress =
    !props.compact &&
    activeOperation?.downloadedBytes !== undefined &&
    activeOperation.totalBytes !== undefined
      ? Math.min(
          100,
          Math.round((activeOperation.downloadedBytes / activeOperation.totalBytes) * 100),
        )
      : null;
  const isWorking = pendingAction !== null || props.disabled === true;

  const startPlan = useCallback(
    async (nextPlan: ProviderRuntimePlan) => {
      setLocalError(null);
      setPendingAction("start");
      const result = await startRuntime({
        environmentId: props.environmentId,
        input: {
          instanceId: props.provider.instanceId,
          action: nextPlan.action,
          catalogRevision: nextPlan.catalogRevision,
        },
      });
      if (result._tag === "Failure") {
        setPendingAction(null);
        if (!isAtomCommandInterrupted(result)) {
          setLocalError(
            providerLifecycleFailureMessage(
              squashAtomCommandFailure(result),
              `Scient could not start the ${props.displayName} runtime operation.`,
            ),
          );
        }
        return;
      }
      const nextRuntime = runtimeFromResult(result.value.providers, props.provider.instanceId);
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
          props.onActionSucceeded?.(nextPlan.action);
        }
      }
      setLocalRuntimeSnapshot(
        nextRuntime ? { baseProvider: props.provider, value: nextRuntime } : null,
      );
      setPlan(null);
      props.onPlanOpenChange?.(false);
      setPendingAction(null);
    },
    [
      startRuntime,
      props.displayName,
      props.environmentId,
      props.onActionSucceeded,
      props.onPlanOpenChange,
      props.provider,
      props.provider.instanceId,
    ],
  );

  const requestPlan = useCallback(
    async (action: ProviderManagedRuntimeAction) => {
      setLocalError(null);
      setPendingAction("plan");
      if (action !== "repair") props.onPlanOpenChange?.(true);
      const result = await planRuntime({
        environmentId: props.environmentId,
        input: { instanceId: props.provider.instanceId, action },
      });
      if (result._tag === "Failure") {
        setPendingAction(null);
        props.onPlanOpenChange?.(false);
        if (!isAtomCommandInterrupted(result)) {
          setLocalError(
            providerLifecycleFailureMessage(
              squashAtomCommandFailure(result),
              `Scient could not prepare the ${props.displayName} setup plan.`,
            ),
          );
        }
        return;
      }
      if (action === "repair") {
        await startPlan(result.value);
        return;
      }
      setPendingAction(null);
      setPlan(result.value);
    },
    [
      planRuntime,
      props.displayName,
      props.environmentId,
      props.onPlanOpenChange,
      props.provider.instanceId,
      startPlan,
    ],
  );

  useEffect(() => {
    if (!props.initialAction) return;
    const requestKey = `${props.provider.instanceId}:${props.initialAction}`;
    if (initialPlanRequestRef.current === requestKey) return;
    initialPlanRequestRef.current = requestKey;
    void requestPlan(props.initialAction);
  }, [props.initialAction, props.provider.instanceId, requestPlan]);

  const start = async () => {
    if (!plan) return;
    await startPlan(plan);
  };

  const cancel = async () => {
    if (!activeOperation) return;
    setLocalError(null);
    setPendingAction("cancel");
    const result = await cancelRuntime({
      environmentId: props.environmentId,
      input: {
        instanceId: props.provider.instanceId,
        operationId: activeOperation.operationId,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          providerLifecycleFailureMessage(
            squashAtomCommandFailure(result),
            `Scient could not cancel the ${props.displayName} runtime operation.`,
          ),
        );
      }
      return;
    }
    const nextRuntime = runtimeFromResult(result.value.providers, props.provider.instanceId);
    setLocalRuntimeSnapshot(
      nextRuntime ? { baseProvider: props.provider, value: nextRuntime } : null,
    );
  };

  if (activeOperation) {
    return (
      <div
        className={props.compact ? "space-y-4 py-1" : "space-y-3 rounded-lg border bg-muted/20 p-3"}
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
        {progress !== null ? (
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
        <div className={props.compact ? "flex justify-end pt-1" : "flex"}>
          <Button
            className={DESTRUCTIVE_GHOST_ACTION_CLASS}
            type="button"
            size="sm"
            variant={props.compact ? "ghost-muted" : "outline"}
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

  if (pendingAction === "plan" && props.initialAction && !plan) {
    return (
      <div
        className={
          props.compact
            ? "flex items-start gap-3 py-1"
            : "flex items-start gap-3 rounded-lg border bg-muted/20 p-3"
        }
      >
        <LoaderIcon className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Preparing installation</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Loading the reviewed {props.displayName} installation details…
          </p>
        </div>
      </div>
    );
  }

  if (plan) {
    const downloadSize = formatDownloadSize(plan.downloadBytes);
    const isRemovePlan = plan.action === "remove";
    const isCompactInstallPlan = props.compact && plan.action === "install";
    return (
      <div
        className={
          props.compact
            ? "space-y-3 py-1"
            : "space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3"
        }
      >
        <div className="flex items-start gap-3">
          <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {isRemovePlan
                ? `Remove ${props.displayName}?`
                : isCompactInstallPlan
                  ? `Install ${props.displayName}`
                  : `Review ${props.displayName} setup`}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {isRemovePlan
                ? `Only Scient’s managed copy will be removed. Your account and other ${props.displayName} installations stay unchanged.`
                : isCompactInstallPlan
                  ? `${plan.version ? `Version ${plan.version}` : props.displayName} · ${platformLabel(plan.target)}${downloadSize ? ` · about ${downloadSize}` : ""}`
                  : plan.message}
            </p>
          </div>
        </div>
        {!isRemovePlan && !isCompactInstallPlan ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Computer</dt>
              <dd className="text-right text-foreground">{platformLabel(plan.target)}</dd>
              {plan.version ? (
                <>
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="text-right text-foreground">{plan.version}</dd>
                </>
              ) : null}
              {downloadSize ? (
                <>
                  <dt className="text-muted-foreground">Download</dt>
                  <dd className="text-right text-foreground">About {downloadSize}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Source</dt>
              <dd className="text-right text-foreground">{plan.sourceLabel}</dd>
            </dl>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Scient keeps this copy inside its private app data and never changes a system or
              custom installation.
            </p>
          </>
        ) : null}
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
              setPlan(null);
              props.onPlanOpenChange?.(false);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant={isRemovePlan ? "ghost-muted" : "default"}
            className={
              isRemovePlan
                ? "text-destructive hover:bg-destructive/8 hover:text-destructive"
                : undefined
            }
            disabled={isWorking}
            onClick={() => void start()}
          >
            {pendingAction === "start" ? <LoaderIcon className="animate-spin" /> : null}
            {isRemovePlan
              ? "Remove"
              : isCompactInstallPlan
                ? "Install"
                : actionLabel(plan.action, props.displayName)}
          </Button>
        </div>
      </div>
    );
  }

  const terminalOperation =
    operation && !isActiveProviderRuntimeOperation(operation) ? operation : null;
  const wasRemoved =
    terminalOperation?.action === "remove" && terminalOperation.status === "succeeded";
  const wasRepaired =
    terminalOperation?.action === "repair" && terminalOperation.status === "succeeded";
  const providerRuntimeError = needsManagedRuntimeRecovery(props.provider)
    ? props.provider.message
    : null;
  const statusMessage =
    (wasRepaired || wasRemoved ? null : terminalOperation?.message) ??
    providerRuntimeError ??
    (runtime.source === "missing" ? runtime.message : null);
  const statusIcon =
    runtime.source === "missing" ||
    terminalOperation?.status === "failed" ||
    providerRuntimeError ? (
      <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
    ) : (
      <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
    );

  return (
    <div className={props.compact ? "space-y-2 border-b pb-3" : "space-y-3 rounded-lg border p-3"}>
      <div className={props.compact ? "flex flex-wrap items-center gap-x-3 gap-y-2" : "space-y-3"}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {statusIcon}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{runtimeSourceLabel(runtime)}</p>
            {props.compact && runtime.managedVersion ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {props.displayName} {runtime.managedVersion}
              </p>
            ) : statusMessage ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {statusMessage}
              </p>
            ) : null}
            {!props.compact && runtime.managedVersion ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {props.displayName} {runtime.managedVersion}
              </p>
            ) : null}
          </div>
        </div>
        {runtime.actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {runtime.actions.map((action) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={
                  action === "install" ? "default" : props.compact ? "ghost-muted" : "outline"
                }
                className={
                  props.compact && action === "remove"
                    ? "hover:bg-destructive/8 hover:text-destructive"
                    : undefined
                }
                disabled={isWorking}
                onClick={() => void requestPlan(action)}
              >
                {pendingAction === "plan" ? (
                  <LoaderIcon className="animate-spin" />
                ) : action === "install" ? (
                  <DownloadIcon />
                ) : action === "remove" ? (
                  <Trash2Icon />
                ) : (
                  <WrenchIcon />
                )}
                {action === "install"
                  ? props.provider.driver === "codex" && runtime.source === "system"
                    ? "Use Scient-managed Codex"
                    : "Review setup"
                  : action === "update"
                    ? "Update"
                    : action === "repair"
                      ? "Repair"
                      : "Remove"}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {localError ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {localError}
        </p>
      ) : null}
      <ProviderRuntimeDiagnosticsDetails
        displayName={props.displayName}
        provider={props.provider}
      />
    </div>
  );
}
