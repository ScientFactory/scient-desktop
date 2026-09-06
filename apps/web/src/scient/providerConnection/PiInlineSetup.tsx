import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { PiIcon } from "../../components/Icons";
import { ConnectModelsButton } from "./ConnectModelsButton";
import { AssistedSetupFrame, AssistedSetupStatus } from "./AssistedProviderSetup";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";
import { providerSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

/** Pi has a managed runtime, but no single provider-owned account flow. */
export function PiInlineSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
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
                : "Add a custom model, or use /login in Pi for a supported subscription."
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
