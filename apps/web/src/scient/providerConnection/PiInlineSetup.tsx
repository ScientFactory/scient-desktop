import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { PiIcon } from "../../components/Icons";
import { AssistedSetupFrame, AssistedSetupStatus } from "./AssistedProviderSetup";
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";

/** Pi has a managed runtime, but no single provider-owned account flow. */
export function PiInlineSetup(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly managedRuntimePresentedExternally?: boolean;
  readonly onRepairSucceeded?: () => void;
}) {
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
      <AssistedSetupFrame>
        <AssistedSetupStatus
          icon={<PiIcon className="size-5 text-primary" />}
          title={
            props.provider.status === "ready" && props.provider.models.length > 0
              ? "Pi models available"
              : "Configure Pi models"
          }
          body="Configure API keys or complete a supported /login flow in Pi on the server machine, then refresh. Pi owns those credentials; there is no single Pi account sign-in here. Full access only; no native sandbox."
        />
      </AssistedSetupFrame>
    </>
  );
}
