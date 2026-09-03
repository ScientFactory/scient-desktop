import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { providerConnectionPresentation } from "../../scient/providerConnection/providerConnectionPresentation";
import { Button } from "../ui/button";
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
      <div
        className={cn(
          "alert-glass relative inline-flex items-center gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 [&_svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive",
        )}
        data-variant={status.status === "warning" ? "warning" : "error"}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <Button
              className="self-start px-0 text-foreground"
              onClick={() => onOpenProviderSetup(status.instanceId)}
              size="xs"
              variant="link"
            >
              Open provider setup
            </Button>
          ) : null}
        </div>
        <Button
          aria-label={`Dismiss ${providerName} provider ${status.status}`}
          className="absolute top-2 right-2 size-6 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
