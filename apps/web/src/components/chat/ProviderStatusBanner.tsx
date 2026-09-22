import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { providerConnectionPresentation } from "../../scient/providerConnection/providerConnectionPresentation";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function isExpectedAssistedLifecycleState(status: ServerProvider): boolean {
  const runtimeOperation = status.connection?.runtime?.operation;
  const connectionOperation = status.connection?.operation;
  if (runtimeOperation?.status === "failed" || connectionOperation?.status === "failed") {
    return false;
  }

  const presentation = providerConnectionPresentation(status);
  if (presentation.kind === "not-installed") {
    return status.connection?.runtime?.actions.includes("install") ?? false;
  }
  return (
    presentation.kind === "setting-up" ||
    presentation.kind === "connecting" ||
    (presentation.kind === "not-connected" && status.auth.status === "unauthenticated")
  );
}

function shouldRenderProviderStatus(status: ServerProvider | null): status is ServerProvider {
  return (
    status !== null &&
    status.status !== "ready" &&
    status.status !== "disabled" &&
    // Saved Antigravity credentials are checked on session start, not by the
    // passive health probe. Keep real lifecycle failures visible.
    !(
      status.driver === "antigravity" &&
      status.installed &&
      status.status === "warning" &&
      status.auth.status === "unknown" &&
      providerLifecycleFailureMessage(status) === null
    ) &&
    !isExpectedAssistedLifecycleState(status)
  );
}

function providerLifecycleFailureMessage(status: ServerProvider): string | null {
  const runtimeOperation = status.connection?.runtime?.operation;
  if (runtimeOperation?.status === "failed") return runtimeOperation.message;
  const connectionOperation = status.connection?.operation;
  return connectionOperation?.status === "failed" ? connectionOperation.message : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  return !shouldRenderProviderStatus(status)
    ? null
    : [
        status.instanceId,
        status.status,
        status.auth.status,
        status.message ?? "",
        providerLifecycleFailureMessage(status) ?? "",
      ].join("\u0000");
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Keep the environment's error intact in both the banner and model picker. */
export function getProviderStatusMessage(status: ServerProvider): string {
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  if (!shouldRenderProviderStatus(status)) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const runtimeFailed = status.connection?.runtime?.operation?.status === "failed";
  const connectionFailed = status.connection?.operation?.status === "failed";
  const lifecycleFailureMessage = providerLifecycleFailureMessage(status);
  const isUnauthenticated =
    !lifecycleFailureMessage &&
    status.status === "error" &&
    status.auth.status === "unauthenticated";
  const title = runtimeFailed
    ? `${providerName} setup failed`
    : connectionFailed
      ? `${providerName} sign-in failed`
      : isUnauthenticated
        ? `${providerName} is unauthenticated`
        : `${providerName} provider status`;
  const message = lifecycleFailureMessage ?? getProviderStatusMessage(status);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={status.status === "warning" ? "warning" : "error"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{message}</TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
              Open provider setup
            </InlineButton>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Dismiss ${providerName} provider ${status.status}`}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
