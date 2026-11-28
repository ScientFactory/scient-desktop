import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo, useRef, useState, useSyncExternalStore } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { providerConnectionPresentation } from "../../scient/providerConnection/providerConnectionPresentation";
import { providerStatusMessageText } from "../../scient/providerConnection/providerStatusMessageCopy";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { m, type MessageResolver } from "../../i18n/messages";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "../ui/refresh-icon";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
// SCIENT-FORK:START — Only the provider on this desktop can offer its app update.
import { ProviderAppUpdateButton } from "../../scient/desktopUpdate/ProviderAppUpdateButton";
// SCIENT-FORK:END

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

function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

function providerLifecycleFailureMessage(status: ServerProvider): string | null {
  const runtimeOperation = status.connection?.runtime?.operation;
  if (runtimeOperation?.status === "failed") return runtimeOperation.message;
  const connectionOperation = status.connection?.operation;
  return connectionOperation?.status === "failed" ? connectionOperation.message : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  // A healthy provider has nothing to say. An incompatible one already
  // returned above, so this cannot hide a real compatibility banner.
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  // Keep real lifecycle failures visible.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown" &&
    providerLifecycleFailureMessage(status) === null
  ) {
    return null;
  }
  if (isExpectedAssistedLifecycleState(status)) return null;
  return [
    status.instanceId,
    status.status,
    status.auth.status,
    status.message ?? "",
    providerLifecycleFailureMessage(status) ?? "",
  ].join("\u0000");
}

function shouldRenderProviderStatus(status: ServerProvider | null): status is ServerProvider {
  return status !== null && getProviderStatusBannerKey(status) !== null;
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  isDismissed: boolean,
): boolean {
  return getProviderStatusBannerKey(status) !== null && !isDismissed;
}

// Built-in instance ids such as `codex` repeat across environments.
export function getProviderStatusDismissalKey(
  environmentId: string | undefined,
  status: ServerProvider | null,
): string | null {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey === null ? null : `${environmentId ?? ""}\u0000${bannerKey}`;
}

// A dismissal lasts the session, not one view, so opening another thread cannot bring it back.
const sessionDismissedProviderStatusBannerKeys = new Set<string>();
const dismissalListeners = new Set<() => void>();

export function dismissProviderStatusBannerForSession(bannerKey: string | null): void {
  if (bannerKey === null || sessionDismissedProviderStatusBannerKeys.has(bannerKey)) return;
  sessionDismissedProviderStatusBannerKeys.add(bannerKey);
  for (const listener of dismissalListeners) listener();
}

export function isProviderStatusBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedProviderStatusBannerKeys.has(bannerKey);
}

function subscribeToDismissals(listener: () => void) {
  dismissalListeners.add(listener);
  return () => dismissalListeners.delete(listener);
}

export function useProviderStatusBannerDismissed(bannerKey: string | null): boolean {
  return useSyncExternalStore(subscribeToDismissals, () =>
    isProviderStatusBannerDismissedForSession(bannerKey),
  );
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Components pass `useMessages()` so the message follows a language switch. */
export function getProviderStatusMessage(
  status: ServerProvider,
  resolve: MessageResolver = m,
): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return providerStatusMessageText(status.message, resolve);
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return resolve(
      msg("Open provider setup to install {provider} on this environment.", {
        provider: formatProviderDriverKindLabel(status.driver),
      }),
    );
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? resolve(msg("Open provider setup to sign in with Google."))
        : resolve(msg("Open provider setup to sign in."));
    }
    return resolve(msg("Sign in via the CLI to authenticate again."));
  }
  return status.status === "ready"
    ? resolve(msg("No models are available for this provider."))
    : status.status === "error"
      ? resolve(msg("{provider} provider is unavailable.", { provider: providerName }))
      : resolve(msg("{provider} provider has limited availability.", { provider: providerName }));
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  environmentId,
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  environmentId: EnvironmentId;
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "Refresh provider status",
  });
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    if (!status || !canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    await refreshProviders({
      environmentId,
      input: { instanceId: status.instanceId, refreshModels: true },
    });
    refreshingRef.current = false;
    setIsRefreshing(false);
  };

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
  const incompatible = status.status === "ready" ? getIncompatibleVersion(status) : null;
  const title = runtimeFailed
    ? gt("{provider} setup failed", { provider: providerName })
    : connectionFailed
      ? gt("{provider} sign-in failed", { provider: providerName })
      : isUnauthenticated
        ? gt("{provider} is unauthenticated", { provider: providerName })
        : incompatible
          ? incompatible.status === "broken"
            ? gt("{provider} {version} is known to be broken", {
                provider: providerName,
                version: status.version ?? "",
              })
            : gt("{provider} {version} is unsupported", {
                provider: providerName,
                version: status.version ?? "",
              })
          : gt("{provider} provider status", { provider: providerName });
  const message =
    lifecycleFailureMessage ?? incompatible?.message ?? getProviderStatusMessage(status, messages);
  // A driver marked broken reads as an error, not a warning.
  const isWarning =
    incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={isWarning ? "warning" : "error"}
        role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-2">
            <SharedTooltipTrigger
              render={<div className="line-clamp-3" />}
              label={message}
              className="whitespace-pre-wrap"
            >
              {message}
            </SharedTooltipTrigger>
            {/* SCIENT-FORK:START — Only the provider on this desktop can offer its app update. */}
            <ProviderAppUpdateButton
              environmentId={environmentId}
              requiresAppUpdate={status.requiresAppUpdate}
            />
            {/* SCIENT-FORK:END */}
            <div className="flex flex-wrap items-center justify-end gap-3">
              {onOpenProviderSetup && hasProviderSetup(status) ? (
                <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
                  <T>Open provider setup</T>
                </InlineButton>
              ) : null}
              <Button
                aria-label={gt("Refresh {provider} provider status", { provider: providerName })}
                disabled={!canRefresh || isRefreshing}
                onClick={() => void refresh()}
                size="xs"
                variant="outline"
              >
                <RefreshIcon />
                {isRefreshing ? gt("Refreshing...") : gt("Refresh")}
              </Button>
            </div>
          </div>
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={
              status.status === "error"
                ? gt("Dismiss {provider} provider error", { provider: providerName })
                : status.status === "warning"
                  ? gt("Dismiss {provider} provider warning", { provider: providerName })
                  : status.status === "ready"
                    ? gt("Dismiss {provider} provider ready", { provider: providerName })
                    : gt("Dismiss {provider} provider disabled", { provider: providerName })
            }
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
