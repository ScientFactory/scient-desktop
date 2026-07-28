// FILE: ProviderUpdateActionButton.tsx
// Purpose: Render the provider CLI update action without conflating availability with activity.
// Layer: Settings component
// Exports: ProviderUpdateActionButton

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@synara/contracts";

import { isProviderUpdateActive, shouldOfferProviderUpdateAction } from "../../providerUpdates";
import { DownloadIcon, Loader2Icon } from "../../lib/icons";
import { Button } from "../ui/button";

export function ProviderUpdateActionButton({
  providerStatus,
  confirmedUpdateVisible,
  locallyUpdating = false,
  onUpdate,
}: {
  readonly providerStatus: ServerProviderStatus;
  readonly confirmedUpdateVisible: boolean;
  readonly locallyUpdating?: boolean;
  readonly onUpdate: () => void;
}) {
  const active = isProviderUpdateActive(providerStatus) || locallyUpdating;
  const offered = confirmedUpdateVisible && shouldOfferProviderUpdateAction(providerStatus);
  if (!offered && !active) {
    return null;
  }

  const providerName = PROVIDER_DISPLAY_NAMES[providerStatus.provider];
  const updateCommand = providerStatus.versionAdvisory?.updateCommand;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={active}
      aria-label={active ? `Updating ${providerName} CLI` : `Update ${providerName} CLI`}
      title={!active && updateCommand ? `Run ${updateCommand}` : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onUpdate();
      }}
    >
      {active ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <DownloadIcon className="size-3.5" />
      )}
      {active ? "Updating" : "Update"}
    </Button>
  );
}
