import type {
  EnvironmentId,
  ProviderConnectionMethod,
  ProviderManagedRuntimeAction,
  ServerProvider,
} from "@t3tools/contracts";
import { DownloadIcon, LoaderIcon, LogInIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  type ProviderSettingsLifecyclePresentation,
  useProviderSettingsLifecyclePresentation,
} from "./providerSettingsLifecyclePresentation";
import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
} from "./providerConnectionPresentation";
import { useEnvironmentIsOnThisDevice } from "./environmentLocality";
import { oneClickSignInMethod } from "./oneClickSignIn";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

export type ProviderSettingsPrimaryAction =
  | { readonly kind: "open"; readonly runtimeAction: ProviderManagedRuntimeAction | null }
  | { readonly kind: "managed-runtime"; readonly action: "install" | "update" }
  | { readonly kind: "browser-sign-in"; readonly method: ProviderConnectionMethod }
  | { readonly kind: "external-update" }
  | { readonly kind: "none" };

/**
 * A row starts sign-in itself only for a provider with exactly one method that
 * signs in through a page Scient opens; any choice, code or pairing opens the
 * provider's setup view instead.
 */
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
    case "sign-in": {
      const method = oneClickSignInMethod(input.provider);
      return method ? { kind: "browser-sign-in", method } : { kind: "open", runtimeAction: null };
    }
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
  const signInMethod = action === "sign-in" ? oneClickSignInMethod(props.provider) : null;
  const presentation = useProviderSettingsLifecyclePresentation(
    props.environmentId,
    props.provider,
    props.displayName,
  );
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
        <ActionDetail detail={operationActive ? presentation.detail : null}>
          <Button
            aria-label={`${progressLabel} ${props.displayName}`}
            onClick={() => props.onManage()}
            size="compact"
            type="button"
            variant="ghost-primary"
          >
            <LoaderIcon aria-hidden className="animate-spin" />
            <span role="status" className="inline-flex items-baseline gap-1.5">
              {progressLabel}
              {operationActive && presentation.downloadPercent !== undefined ? (
                <span
                  aria-label={`Download progress ${presentation.downloadPercent}%`}
                  className="text-[11px] font-normal tabular-nums text-muted-foreground"
                >
                  {presentation.downloadPercent}%
                </span>
              ) : null}
            </span>
          </Button>
        </ActionDetail>
      ) : action === "install" ? (
        <ManagedRuntimeActionButton
          action="install"
          displayName={props.displayName}
          environmentId={props.environmentId}
          onManage={props.onManage}
          provider={props.provider}
        />
      ) : action === "sign-in" ? (
        // After a failed attempt the row retries, with the reason on hover.
        <ActionDetail detail={presentation.kind === "failed" ? presentation.detail : null}>
          {signInMethod ? (
            <BrowserSignInButton
              displayName={props.displayName}
              environmentId={props.environmentId}
              method={signInMethod}
              onManage={props.onManage}
              provider={props.provider}
              retry={presentation.kind === "failed"}
            />
          ) : (
            <Button
              onClick={() => props.onManage()}
              size="compact"
              type="button"
              variant="ghost-primary"
            >
              {presentation.kind === "failed" ? <RefreshCwIcon /> : <LogInIcon />}
              {presentation.kind === "failed" ? "Retry" : "Sign in"}
            </Button>
          )}
        </ActionDetail>
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

/** The text behind a row's short label, such as a slow start or why sign-in failed. */
function ActionDetail(props: { readonly detail: string | null; readonly children: ReactNode }) {
  if (!props.detail) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{props.children}</span>} />
      <TooltipPopup side="top">{props.detail}</TooltipPopup>
    </Tooltip>
  );
}

function BrowserSignInButton(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly method: ProviderConnectionMethod;
  readonly onManage: () => void;
  readonly retry: boolean;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const onThisDevice = useEnvironmentIsOnThisDevice(props.environmentId);

  const continueSignIn = (provider: ServerProvider) => {
    const operation = provider.connection?.operation;
    // A flow waiting on a code or pairing continues in the setup view.
    if (
      onThisDevice &&
      isActiveProviderConnectionOperation(operation) &&
      !(operation?.status === "waiting_for_browser" && operation.authorizationUrlKind === "primary")
    ) {
      props.onManage();
    }
  };

  // From the click the row shows the starting state, like the server's, so this
  // button is replaced at once; the start continues without it.
  const signIn = async () => {
    // On another device the browser cannot reach the provider's 127.0.0.1 return
    // address, so the setup card is shown for pasting the return URL.
    if (!onThisDevice) props.onManage();
    try {
      // The controller opens the sign-in page for this client once it is ready.
      const provider = await controller.startConnection(props.method);
      continueSignIn(provider);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not sign in to ${props.displayName}`,
          description: actionErrorMessage(error),
        }),
      );
    }
  };

  return (
    <Button onClick={() => void signIn()} size="compact" type="button" variant="ghost-primary">
      {props.retry ? <RefreshCwIcon /> : <LogInIcon />}
      {props.retry ? "Retry" : "Sign in"}
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
    let actionFailure: { readonly cause: unknown } | undefined;
    try {
      try {
        const plan = await controller.planRuntime(props.action);
        await controller.startRuntime(plan);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not ${props.action} ${props.displayName}`,
            description: actionErrorMessage(error),
          }),
        );
      }
    } catch (cause) {
      actionFailure = { cause };
    }
    pendingRef.current = false;
    setPending(false);
    if (actionFailure) throw actionFailure.cause;
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
