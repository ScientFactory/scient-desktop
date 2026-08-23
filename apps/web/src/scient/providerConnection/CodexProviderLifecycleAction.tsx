import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import {
  hasExternalCodexUpdate,
  hasManagedCodexUpdate,
  startCodexBrowserSignIn,
  startReviewedCodexRuntimeAction,
  updateCodexRuntime,
} from "./codexLifecycleActions";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The provider action could not be completed.";
}

export function CodexProviderLifecycleAction(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly onManage: () => void;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  const [pending, setPending] = useState<"install" | "sign-in" | "update" | null>(null);
  const presentation = providerSettingsLifecyclePresentation(props.provider, props.displayName);
  const runtime = props.provider.connection?.runtime;
  const managedUpdateAvailable = hasManagedCodexUpdate(props.provider);
  const externalUpdateAvailable = hasExternalCodexUpdate(props.provider);
  const updateAvailable = managedUpdateAvailable || externalUpdateAvailable;
  const updateRunning =
    props.provider.updateState?.status === "queued" ||
    props.provider.updateState?.status === "running" ||
    (runtime?.operation?.action === "update" &&
      ["preparing", "downloading", "verifying", "installing", "testing", "activating"].includes(
        runtime.operation.status,
      ));
  const installFailed = !props.provider.installed && runtime?.operation?.status === "failed";
  const canInstallManaged = runtime?.actions.includes("install") ?? false;
  const shouldOfferManagedInstall =
    canInstallManaged &&
    (runtime?.source === "missing" ||
      props.provider.auth.status === "authenticated" ||
      props.provider.auth.required === false);
  const signInFailed =
    props.provider.installed &&
    props.provider.auth.status !== "authenticated" &&
    props.provider.connection?.operation?.status === "failed";

  const run = async (action: "install" | "sign-in" | "update") => {
    setPending(action);
    try {
      if (action === "install") {
        await startReviewedCodexRuntimeAction(controller, "install");
      } else if (action === "sign-in") {
        await startCodexBrowserSignIn(controller);
      } else {
        await updateCodexRuntime(controller, props.provider);
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${action === "sign-in" ? "sign in to" : action} Codex`,
          description: errorMessage(error),
        }),
      );
    } finally {
      setPending(null);
    }
  };

  if (updateAvailable || updateRunning) {
    return (
      <Button
        className="h-6 min-w-14 px-2 text-[11px] font-semibold shadow-none"
        disabled={pending !== null || updateRunning}
        onClick={() => void run("update")}
        size="xs"
        type="button"
      >
        {pending === "update" || updateRunning ? <LoaderIcon className="animate-spin" /> : null}
        {pending === "update" || updateRunning ? "Updating" : "Update"}
      </Button>
    );
  }

  if (presentation.kind === "not-installed" || installFailed || shouldOfferManagedInstall) {
    if (!canInstallManaged) return null;
    return (
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={pending !== null}
        onClick={() => void run("install")}
        size="sm"
        type="button"
      >
        {pending === "install" ? <LoaderIcon className="animate-spin" /> : null}
        {installFailed ? "Retry" : "Install"}
      </Button>
    );
  }

  if (presentation.kind === "sign-in-required" || signInFailed) {
    return (
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={pending !== null}
        onClick={() => void run("sign-in")}
        size="sm"
        type="button"
      >
        {pending === "sign-in" ? <LoaderIcon className="animate-spin" /> : null}
        {signInFailed ? "Retry" : "Sign in"}
      </Button>
    );
  }

  return (
    <Button
      className="h-6.5 px-2.5 text-xs"
      onClick={props.onManage}
      size="sm"
      type="button"
      variant="outline"
    >
      {presentation.busy ? <LoaderIcon className="animate-spin" /> : null}
      {presentation.busy ? "Continue" : "Manage"}
    </Button>
  );
}
