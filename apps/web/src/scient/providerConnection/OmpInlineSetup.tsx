import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { ProviderRuntimeSection } from "./ProviderRuntimeSection";

/** Oh My Pi can be installed by Scient. Model sign-in stays in Oh My Pi. */
export function OmpInlineSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
  if (props.managedRuntimePresentedExternally) return null;
  return (
    <ProviderRuntimeSection
      compact
      environmentId={props.environmentId}
      provider={props.provider}
      displayName={props.displayName}
      onActionSucceeded={(action) => {
        if (action === "repair") props.onRepairSucceeded?.();
      }}
    />
  );
}
