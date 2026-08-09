import type { EnvironmentId } from "@t3tools/contracts";
import { DownloadIcon, LoaderIcon, LogInIcon } from "lucide-react";
import { useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../../components/ui/button";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { ProviderConnectionDialog } from "./ProviderConnectionDialog";
import {
  canManageProviderLifecycle,
  providerConnectionPresentation,
} from "./providerConnectionPresentation";

export function ProviderConnectionComposerAction(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: ProviderInstanceEntry;
}) {
  const [open, setOpen] = useState(false);
  const presentation = providerConnectionPresentation(props.entry.snapshot);
  if (!canManageProviderLifecycle(props.entry.snapshot) || presentation.kind === "connected") {
    return null;
  }

  const connecting = presentation.kind === "connecting";
  const settingUp = presentation.kind === "setting-up";
  const needsRuntime = presentation.kind === "not-installed";
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-chat-provider-connection="true"
        className="shrink-0 gap-1.5 px-2 text-secondary-label sm:px-3"
        onClick={() => setOpen(true)}
      >
        <ProviderInstanceIcon
          driverKind={props.entry.driverKind}
          displayName={props.entry.displayName}
          accentColor={props.entry.accentColor}
          showBadge={Boolean(props.entry.accentColor)}
          className="size-4"
          iconClassName="size-4"
          indicatorBackground="var(--input)"
        />
        <span>
          {settingUp
            ? `Continue ${props.entry.displayName} setup`
            : needsRuntime
              ? `Set up ${props.entry.displayName}`
              : connecting
                ? `Finish ${props.entry.displayName} sign in`
                : `Sign in to ${props.entry.displayName}`}
        </span>
        {connecting || settingUp ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : needsRuntime ? (
          <DownloadIcon className="size-3.5" />
        ) : (
          <LogInIcon className="size-3.5" />
        )}
      </Button>
      <ProviderConnectionDialog
        environmentId={props.environmentId}
        provider={props.entry.snapshot}
        displayName={props.entry.displayName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
