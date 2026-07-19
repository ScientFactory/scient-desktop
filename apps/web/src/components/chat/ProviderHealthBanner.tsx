// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@synara/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { Button } from "../ui/button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  onConnect,
  onDismiss,
  status,
}: {
  onConnect?: (provider: ServerProviderStatus["provider"]) => void;
  onDismiss?: () => void;
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const Icon = status.status === "error" ? CircleAlertIcon : TriangleAlertIcon;
  const canConnect = !status.available || status.authStatus === "unauthenticated";

  return (
    <ChatColumnBannerFrame>
      <Alert
        className={cn(EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME, "pr-10")}
        variant={status.status === "error" ? "error" : "warning"}
      >
        <Icon className={NOTIFICATION_ICON_CLASS_NAME} />
        <AlertTitle className="font-normal text-[var(--notification-fg)]">{title}</AlertTitle>
        <AlertDescription
          className="line-clamp-3 text-[var(--notification-fg)]/72"
          title={status.message ?? defaultMessage}
        >
          {status.message ?? defaultMessage}
        </AlertDescription>
        {(onConnect && canConnect) || onDismiss ? (
          <AlertAction className="absolute top-2 right-2 items-center">
            {onConnect && canConnect ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-6 border-transparent px-2 text-[var(--notification-fg)] hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35"
                onClick={() => onConnect(status.provider)}
              >
                {status.available ? "Connect" : "Set up"}
              </Button>
            ) : null}
            {onDismiss ? (
              <IconButton
                className="size-6 rounded-full text-[var(--notification-fg)]/65 hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35 sm:size-6"
                label="Dismiss provider status"
                title="Dismiss provider status"
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </IconButton>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
});
