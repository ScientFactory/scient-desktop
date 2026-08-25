import type {
  EnvironmentId,
  ProviderManagedRuntimeAction,
  ServerProvider,
} from "@t3tools/contracts";
import {
  DownloadIcon,
  LoaderIcon,
  LogInIcon,
  RefreshCwIcon,
  Settings2Icon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { startCodexBrowserSignIn } from "./codexLifecycleActions";
import { startReviewedProviderRuntimeAction } from "./providerLifecycleActions";
import { PRIMARY_GHOST_ACTION_CLASS } from "./providerConnectionActionStyles";
import {
  providerSettingsLifecyclePresentation,
  type ProviderSettingsLifecyclePresentation,
} from "./providerSettingsLifecyclePresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

const SETTINGS_LIFECYCLE_PRIMARY_ACTION_CLASS = `h-7 gap-1.5 px-2.5 text-xs ${PRIMARY_GHOST_ACTION_CLASS}`;
const SETTINGS_LIFECYCLE_NEUTRAL_ACTION_CLASS =
  "h-7 gap-1.5 px-2.5 text-xs text-muted-foreground [--control-icon-color:currentColor] hover:bg-accent hover:text-foreground";

export type ProviderSettingsPrimaryAction =
  | { readonly kind: "open"; readonly runtimeAction: ProviderManagedRuntimeAction | null }
  | { readonly kind: "managed-update" }
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
      return input.presentation.runtimeAction === "update"
        ? { kind: "managed-update" }
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

export function ProviderSettingsLifecycleAction(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly onManage: (runtimeAction?: ProviderManagedRuntimeAction) => void;
  readonly onRunExternalUpdate?: (() => void) | undefined;
  readonly externalUpdateRunning?: boolean | undefined;
}) {
  const presentation = providerSettingsLifecyclePresentation(props.provider, props.displayName);
  if (presentation.kind === "checking") {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-muted-foreground text-xs"
        role="status"
      >
        <LoaderIcon aria-hidden className="size-4 animate-spin" />
        <span>Checking</span>
        <span className="sr-only">{props.displayName} status</span>
      </span>
    );
  }
  const primaryAction = resolveProviderSettingsPrimaryAction({
    provider: props.provider,
    presentation,
    canRunExternalUpdate: props.onRunExternalUpdate !== undefined,
  });

  if (primaryAction.kind === "codex-browser-sign-in") {
    return (
      <CodexBrowserSignInButton
        displayName={props.displayName}
        environmentId={props.environmentId}
        provider={props.provider}
      />
    );
  }
  if (primaryAction.kind === "managed-update") {
    return (
      <ManagedRuntimeUpdateButton
        displayName={props.displayName}
        environmentId={props.environmentId}
        provider={props.provider}
      />
    );
  }
  if (primaryAction.kind === "none") return null;

  const externallyUpdating =
    primaryAction.kind === "external-update" && props.externalUpdateRunning === true;

  const run = () => {
    switch (primaryAction.kind) {
      case "external-update":
        props.onRunExternalUpdate?.();
        return;
      case "open":
        props.onManage(primaryAction.runtimeAction ?? undefined);
        return;
    }
  };

  return (
    <Button
      className={
        presentation.actionKind === "manage"
          ? SETTINGS_LIFECYCLE_NEUTRAL_ACTION_CLASS
          : SETTINGS_LIFECYCLE_PRIMARY_ACTION_CLASS
      }
      disabled={externallyUpdating}
      onClick={run}
      size="sm"
      type="button"
      variant="ghost"
    >
      {externallyUpdating || presentation.busy ? (
        <LoaderIcon className="animate-spin" />
      ) : presentation.actionKind === "sign-in" ? (
        <LogInIcon />
      ) : primaryAction.kind === "external-update" || presentation.runtimeAction === "update" ? (
        <RefreshCwIcon />
      ) : presentation.runtimeAction === "install" ? (
        <DownloadIcon />
      ) : presentation.runtimeAction === "repair" ? (
        <WrenchIcon />
      ) : (
        <Settings2Icon />
      )}
      {externallyUpdating ? "Updating" : presentation.actionLabel}
    </Button>
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
      className={SETTINGS_LIFECYCLE_PRIMARY_ACTION_CLASS}
      disabled={pending}
      onClick={() => void signIn()}
      size="sm"
      type="button"
      variant="ghost"
    >
      {pending ? <LoaderIcon className="animate-spin" /> : <LogInIcon />}
      {pending ? "Signing in" : "Sign in"}
    </Button>
  );
}

function ManagedRuntimeUpdateButton(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [pending, setPending] = useState(false);

  const update = async () => {
    setPending(true);
    try {
      await startReviewedProviderRuntimeAction(controller, "update");
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${props.displayName}`,
          description: actionErrorMessage(error),
        }),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      className={SETTINGS_LIFECYCLE_PRIMARY_ACTION_CLASS}
      disabled={pending}
      onClick={() => void update()}
      size="sm"
      type="button"
      variant="ghost"
    >
      {pending ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
      {pending ? "Updating" : "Update"}
    </Button>
  );
}
