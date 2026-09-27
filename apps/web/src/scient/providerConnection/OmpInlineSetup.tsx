import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { OhMyPiIcon } from "../../components/Icons";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

/** Oh My Pi can be installed by Scient. Model sign-in stays in Oh My Pi. */
export function OmpInlineSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
  readonly composerController?: ProviderLifecycleController;
}) {
  if (props.composerController) {
    return (
      <ManagedRuntimeComposerSetup
        key={props.provider.instanceId}
        controller={props.composerController}
        displayName={props.displayName}
        environmentId={props.environmentId}
        icon={OhMyPiIcon}
        modelSetupHint="Add a custom model, or sign in to a model provider in Oh My Pi."
        provider={props.provider}
      />
    );
  }
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
