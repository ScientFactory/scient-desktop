import type {
  EnvironmentId,
  ProviderManagedRuntimeAction,
  ServerProvider,
} from "@t3tools/contracts";
import { DownloadIcon, LoaderIcon, LogInIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { startCodexBrowserSignIn } from "./codexLifecycleActions";
import {
  isRuntimePlanStale,
  managedRuntimeSwitchNeedsDecision,
} from "./ManagedRuntimeSwitchDecision";
import {
  providerSettingsLifecyclePresentation,
  type ProviderSettingsLifecyclePresentation,
} from "./providerSettingsLifecyclePresentation";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
} from "./providerConnectionPresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

export type ProviderSettingsPrimaryAction =
  | { readonly kind: "open"; readonly runtimeAction: ProviderManagedRuntimeAction | null }
  | { readonly kind: "managed-runtime"; readonly action: "install" | "update" }
  | { readonly kind: "codex-browser-sign-in" }
  | { readonly kind: "external-update" }
  | { readonly kind: "none" };

/** Keep provider-specific fast paths explicit and small. */
export function resolveProviderSettingsPrimaryAction(input: {
  readonly provider: ServerProvider;
  readonly presentation: ProviderSettingsLifecyclePresentation;
  readonly canRunExternalUpdate: boolean;
}): ProviderSettingsPrimaryAction {
  switch (input.presentation.actionKind) {
    case "runtime":
      return input.presentation.runtimeAction === "install" ||
        input.presentation.runtimeAction === "update"
        ? { kind: "managed-runtime", action: input.presentation.runtimeAction }
        : { kind: "open", runtimeAction: input.presentation.runtimeAction };
    case "external-update":
      return input.canRunExternalUpdate
        ? { kind: "external-update" }
        : { kind: "open", runtimeAction: null };
    case "sign-in":
      return input.provider.driver === "codex" &&
        input.provider.connection?.methods.includes("codex_browser")
        ? { kind: "codex-browser-sign-in" }
        : { kind: "open", runtimeAction: null };
    case "continue":
    case "manage":
      return { kind: "open", runtimeAction: null };
    case null:
      return { kind: "none" };
  }
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The provider action could not be completed.";
}

interface ProviderSettingsLifecycleActionProps {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly onManage: (runtimeAction?: ProviderManagedRuntimeAction) => void;
  readonly onRunExternalUpdate?: (() => void) | undefined;
  readonly externalUpdateRunning?: boolean | undefined;
}

function resolveProviderSettingsHeaderAction(
  provider: ServerProvider,
): "install" | "sign-in" | "manage" {
  if (
    !provider.enabled ||
    provider.probePending === true ||
    isActiveProviderRuntimeOperation(provider.connection?.runtime?.operation ?? null) ||
    isActiveProviderConnectionOperation(provider.connection?.operation ?? null)
  )
    return "manage";
  const installed = isProviderRuntimePresentedAsInstalled(provider);
  if (!installed && provider.connection?.runtime?.actions.includes("install")) return "install";
  if (
    installed &&
    provider.auth.required !== false &&
    provider.auth.status !== "authenticated" &&
    (provider.connection?.methods.length ?? 0) > 0
  )
    return "sign-in";
  return "manage";
}

export function ProviderSettingsLifecycleAction(props: ProviderSettingsLifecycleActionProps) {
  const action = resolveProviderSettingsHeaderAction(props.provider);
  const presentation = providerSettingsLifecyclePresentation(props.provider, props.displayName);
  const operationActive = presentation.kind === "installing" || presentation.kind === "signing-in";
  const externalUpdateActive =
    props.externalUpdateRunning === true ||
    props.provider.updateState?.status === "queued" ||
    props.provider.updateState?.status === "running";
  const progressLabel = operationActive
    ? presentation.statusLabel
    : externalUpdateActive
      ? "Updating"
      : null;
  return (
    <ProviderSettingsActions
      displayName={props.displayName}
      onManage={props.onManage}
      labeled={progressLabel === null && action === "manage"}
    >
      {progressLabel !== null ? (
        <Button
          aria-label={`${progressLabel} ${props.displayName}`}
          onClick={() => props.onManage()}
          size="compact"
          type="button"
          variant="ghost-primary"
        >
          <LoaderIcon aria-hidden />
          <span role="status" className="inline-flex items-baseline gap-1.5">
            {progressLabel}
            {operationActive && presentation.downloadPercent !== undefined ? (
              <span
                aria-label={`Download progress ${presentation.downloadPercent}%`}
                className="text-[11px] font-normal tabular-nums"
              >
                {presentation.downloadPercent}%
              </span>
            ) : null}
          </span>
        </Button>
      ) : action === "install" ? (
        <ManagedRuntimeActionButton
          action="install"
          displayName={props.displayName}
          environmentId={props.environmentId}
          onManage={props.onManage}
          provider={props.provider}
        />
      ) : action === "sign-in" ? (
        props.provider.driver === "codex" &&
        props.provider.connection?.methods.includes("codex_browser") ? (
          <CodexBrowserSignInButton
            displayName={props.displayName}
            environmentId={props.environmentId}
            provider={props.provider}
          />
        ) : (
          <Button
            onClick={() => props.onManage()}
            size="compact"
            type="button"
            variant="ghost-primary"
          >
            <LogInIcon /> Sign in
          </Button>
        )
      ) : null}
    </ProviderSettingsActions>
  );
}

function ProviderSettingsActions(props: {
  readonly children: ReactNode;
  readonly labeled: boolean;
  readonly displayName: string;
  readonly onManage: () => void;
}) {
  const manageLabel = `Manage ${props.displayName}`;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {props.children}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={manageLabel}
              onClick={() => props.onManage()}
              size={props.labeled ? "compact" : "icon-xs"}
              type="button"
              variant="ghost-muted"
            >
              <Settings2Icon />
              {props.labeled ? "Manage" : null}
            </Button>
          }
        />
        <TooltipPopup side="top">{manageLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function CodexBrowserSignInButton(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [pending, setPending] = useState(false);

  const signIn = async () => {
    setPending(true);
    try {
      await startCodexBrowserSignIn(controller);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not sign in to ${props.displayName}`,
          description: actionErrorMessage(error),
        }),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      disabled={pending}
      onClick={() => void signIn()}
      size="compact"
      type="button"
      variant="ghost-primary"
    >
      {pending ? <LoaderIcon className="animate-spin" /> : <LogInIcon />}
      {pending ? "Signing in" : "Sign in"}
    </Button>
  );
}

function ManagedRuntimeActionButton(props: {
  readonly action: "install" | "update";
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly onManage: (runtimeAction?: ProviderManagedRuntimeAction) => void;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const run = async () => {
    // A second click opens details, including before React renders the pending state.
    if (pendingRef.current) {
      props.onManage();
      return;
    }
    pendingRef.current = true;
    setPending(true);
    try {
      const plan = await controller.planRuntime(props.action);
      // Replacing a newer system runtime, or one of unknown version, is decided
      // in the dialog, which plans the action again; this click starts nothing.
      if (managedRuntimeSwitchNeedsDecision(plan)) {
        props.onManage(props.action);
        return;
      }
      await controller.startRuntime(plan);
    } catch (error) {
      if (isRuntimePlanStale(error)) {
        props.onManage(props.action);
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${props.action} ${props.displayName}`,
          description: actionErrorMessage(error),
        }),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const label =
    props.action === "install"
      ? pending
        ? "Installing"
        : "Install"
      : pending
        ? "Updating"
        : "Update";
  return (
    <Button
      aria-label={`${label} ${props.displayName}`}
      onClick={run}
      size="compact"
      type="button"
      variant={pending ? "ghost-muted" : "ghost-primary"}
    >
      {pending ? (
        <LoaderIcon className="animate-spin" />
      ) : props.action === "install" ? (
        <DownloadIcon />
      ) : (
        <RefreshCwIcon />
      )}
      {label}
    </Button>
  );
}
