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
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/button";
import { CodexRuntimeDiagnosticsDetails } from "./CodexRuntimeDiagnostics";
import { needsManagedRuntimeRecovery } from "./providerConnectionPresentation";

type PendingAction = "plan" | "start" | "cancel" | null;

const ACTIVE_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
]);

function failureMessage(value: unknown, fallback: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  ) {
    return value.message;
  }
  return fallback;
}

function runtimeFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ProviderRuntimeSummary | undefined {
  return providers.find((provider) => provider.instanceId === instanceId)?.connection?.runtime;
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
  if (runtime.source === "scient_managed") return "Managed privately by Scient";
  if (runtime.source === "system") return "Using the installation on this computer";
  if (runtime.source === "custom") return "Using your custom installation";
  if (runtime.source === "missing") return "Provider tool required";
  return "Provider tool status unavailable";
}

export function ProviderRuntimeSection(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
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
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [plan, setPlan] = useState<ProviderRuntimePlan | null>(null);
  const [localRuntime, setLocalRuntime] = useState<ProviderRuntimeSummary | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setPendingAction(null);
    setPlan(null);
    setLocalRuntime(null);
    setLocalError(null);
  }, [props.provider.instanceId]);

  const serverRuntime = props.provider.connection?.runtime;
  const runtime = useMemo(() => {
    if (!serverRuntime) return localRuntime;
    if (!localRuntime) return serverRuntime;
    if (serverRuntime.operation?.operationId === localRuntime.operation?.operationId) {
      return serverRuntime;
    }
    return localRuntime.operation && ACTIVE_RUNTIME_STATUSES.has(localRuntime.operation.status)
      ? localRuntime
      : serverRuntime;
  }, [localRuntime, serverRuntime]);

  if (!runtime) return null;

  const operation = runtime.operation;
  const activeOperation =
    operation && ACTIVE_RUNTIME_STATUSES.has(operation.status) ? operation : null;
  const progress =
    activeOperation?.downloadedBytes !== undefined && activeOperation.totalBytes !== undefined
      ? Math.min(
          100,
          Math.round((activeOperation.downloadedBytes / activeOperation.totalBytes) * 100),
        )
      : null;
  const isWorking = pendingAction !== null;

  const requestPlan = async (action: ProviderManagedRuntimeAction) => {
    setLocalError(null);
    setPendingAction("plan");
    const result = await planRuntime({
      environmentId: props.environmentId,
      input: { instanceId: props.provider.instanceId, action },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          failureMessage(
            squashAtomCommandFailure(result),
            `Scient could not prepare the ${props.displayName} setup plan.`,
          ),
        );
      }
      return;
    }
    setPlan(result.value);
  };

  const start = async () => {
    if (!plan) return;
    setLocalError(null);
    setPendingAction("start");
    const result = await startRuntime({
      environmentId: props.environmentId,
      input: {
        instanceId: props.provider.instanceId,
        action: plan.action,
        catalogRevision: plan.catalogRevision,
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setLocalError(
          failureMessage(
            squashAtomCommandFailure(result),
            `Scient could not start the ${props.displayName} runtime operation.`,
          ),
        );
      }
      return;
    }
    setPlan(null);
    setLocalRuntime(runtimeFromResult(result.value.providers, props.provider.instanceId) ?? null);
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
          failureMessage(
            squashAtomCommandFailure(result),
            `Scient could not cancel the ${props.displayName} runtime operation.`,
          ),
        );
      }
      return;
    }
    setLocalRuntime(runtimeFromResult(result.value.providers, props.provider.instanceId) ?? null);
  };

  if (activeOperation) {
    return (
      <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
        <div className="flex items-start gap-3">
          <LoaderIcon className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{activeOperation.message}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              You can keep using Scient. The previous working runtime remains available until the
              new copy is verified.
            </p>
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isWorking}
          onClick={() => void cancel()}
        >
          {pendingAction === "cancel" ? <LoaderIcon className="animate-spin" /> : <XIcon />}
          Cancel
        </Button>
      </div>
    );
  }

  if (plan) {
    const downloadSize = formatDownloadSize(plan.downloadBytes);
    return (
      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
        <div className="flex items-start gap-3">
          <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Review {props.displayName} setup</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{plan.message}</p>
          </div>
        </div>
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
          Scient keeps this copy inside its private app data and never changes a system or custom
          installation.
        </p>
        {localError ? (
          <p role="alert" className="text-xs leading-relaxed text-destructive">
            {localError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isWorking}
            onClick={() => setPlan(null)}
          >
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant={plan.action === "remove" ? "destructive" : "default"}
            disabled={isWorking}
            onClick={() => void start()}
          >
            {pendingAction === "start" ? <LoaderIcon className="animate-spin" /> : null}
            {actionLabel(plan.action, props.displayName)}
          </Button>
        </div>
      </div>
    );
  }

  const terminalOperation =
    operation && !ACTIVE_RUNTIME_STATUSES.has(operation.status) ? operation : null;
  const providerRuntimeError = needsManagedRuntimeRecovery(props.provider)
    ? props.provider.message
    : null;
  const statusIcon =
    runtime.source === "missing" ||
    terminalOperation?.status === "failed" ||
    providerRuntimeError ? (
      <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
    ) : (
      <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
    );

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-start gap-3">
        {statusIcon}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{runtimeSourceLabel(runtime)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {terminalOperation?.message ?? providerRuntimeError ?? runtime.message}
          </p>
          {runtime.managedVersion ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Private version {runtime.managedVersion}
            </p>
          ) : null}
        </div>
      </div>
      {localError ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {localError}
        </p>
      ) : null}
      {runtime.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {runtime.actions.map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === "install" ? "default" : "outline"}
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
                : actionLabel(action, props.displayName)}
            </Button>
          ))}
        </div>
      ) : null}
      {props.provider.driver === "codex" ? (
        <CodexRuntimeDiagnosticsDetails provider={props.provider} />
      ) : null}
    </div>
  );
}
