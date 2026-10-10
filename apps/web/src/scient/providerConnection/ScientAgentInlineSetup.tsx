import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { ScientAgentIcon } from "../../components/Icons";
import { ConnectModelsButton } from "./ConnectModelsButton";
import { scientAgentAccounts, scientAgentAccountOperation } from "./scientAgentAccountList";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import { ScientAgentAccounts } from "./ScientAgentAccounts";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

/** Scient Agent can be installed by Scient, and signs in to model accounts from here. */
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
        modelSetupHint="Sign in to a model account or add a custom model in Settings > Providers."
        provider={props.provider}
        renderModelSetupAction={(appearance) => (
          <ConnectModelsButton
            appearance={appearance}
            environmentId={props.environmentId}
            instanceId={props.provider.instanceId}
            accountContent={
              scientAgentAccounts(props.provider) !== undefined ||
              scientAgentAccountOperation(props.provider) !== null ? (
                <ScientAgentAccounts
                  key={props.provider.instanceId}
                  environmentId={props.environmentId}
                  provider={props.provider}
                />
              ) : undefined
            }
          />
        )}
      />
    );
  }
  return (
    <>
      {props.managedRuntimePresentedExternally ? null : (
        <ProviderRuntimeSection
          compact
          environmentId={props.environmentId}
          provider={props.provider}
          displayName={props.displayName}
          onActionSucceeded={(action) => {
            if (action === "repair") props.onRepairSucceeded?.();
          }}
        />
      )}
      <ScientAgentAccounts
        key={props.provider.instanceId}
        environmentId={props.environmentId}
        provider={props.provider}
      />
    </>
  );
}
