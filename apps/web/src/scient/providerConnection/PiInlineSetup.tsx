import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { PiIcon } from "../../components/Icons";
import { ConnectModelsButton } from "./ConnectModelsButton";
import { AssistedSetupFrame, AssistedSetupStatus } from "./AssistedProviderSetup";
import { ManagedRuntimeComposerSetup } from "./ManagedRuntimeComposerSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

const PI_MODEL_SETUP_HINT = "Add a custom model, or use /login in Pi for a supported subscription.";

/** Pi has a managed runtime, but no single provider-owned account flow. */
export function PiInlineSetup(props: {
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
        icon={PiIcon}
        modelSetupHint={PI_MODEL_SETUP_HINT}
        provider={props.provider}
      />
    );
  }
  const presentation = providerSettingsLifecyclePresentation(props.provider, props.displayName);
  const showModelSetup = presentation.kind === "manual";
  return (
    <>
      {!props.managedRuntimePresentedExternally ? (
        <ProviderRuntimeSection
          compact
          environmentId={props.environmentId}
          provider={props.provider}
          displayName={props.displayName}
          onActionSucceeded={(action) => {
            if (action === "repair") props.onRepairSucceeded?.();
          }}
        />
      ) : null}
      {showModelSetup ? (
        <AssistedSetupFrame>
          <AssistedSetupStatus
            icon={<PiIcon className="size-5 text-primary" />}
            title={
              props.provider.status === "error"
                ? "Could not load Pi models"
                : "Connect a model provider"
            }
            body={
              props.provider.status === "error"
                ? (props.provider.message ?? "Refresh to try again.")
                : PI_MODEL_SETUP_HINT
            }
          />
        </AssistedSetupFrame>
      ) : null}
      {props.provider.installed && !props.provider.probePending ? (
        <ConnectModelsButton
          environmentId={props.environmentId}
          instanceId={props.provider.instanceId}
        />
      ) : null}
    </>
  );
}
