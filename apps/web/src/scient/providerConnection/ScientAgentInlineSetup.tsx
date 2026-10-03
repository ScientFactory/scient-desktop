import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { ScientAgentIcon } from "../../components/Icons";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

/** Scient Agent can be installed by Scient. Model connections are configured separately. */
export function ScientAgentInlineSetup(props: {
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
        icon={ScientAgentIcon}
        modelSetupHint="Add a custom model, or sign in with the Scient Agent CLI, then refresh providers."
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
