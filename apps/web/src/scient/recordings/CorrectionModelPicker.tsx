import { pickModelSelection } from "@t3tools/shared/model";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getTextGenerationModelOptionsByInstance } from "../../modelSelection";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { useTextGenerationTargets } from "../../textGenerators";

type Props = {
  selection: ModelSelection | undefined;
  label?: string;
  providerOnly?: boolean;
  onChange: (selection: ModelSelection) => void;
};

export function CorrectionModelPicker(props: Props) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? (
    <EnvironmentCorrectionModelPicker {...props} environmentId={environmentId} />
  ) : null;
}

function EnvironmentCorrectionModelPicker({
  selection,
  onChange,
  environmentId,
  label,
  providerOnly,
}: Props & { environmentId: EnvironmentId }) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId ? (providersByEnvironment.get(environmentId) ?? []) : [];
  const selected = selection ?? settings.textGenerationModelSelection;
  const targets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [selected],
  });
  const pickerLabel = label ?? gt("Correction model");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>{pickerLabel}</span>
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={selected.instanceId}
        model={selected.model}
        lockedProvider={null}
        instanceEntries={
          providerOnly
            ? targets.entries.filter((entry) =>
                providers.some(({ instanceId }) => entry.instanceId === instanceId),
              )
            : targets.entries
        }
        modelOptionsByInstance={getTextGenerationModelOptionsByInstance(
          settings,
          targets.providers,
          selected.instanceId,
          selected.model,
        )}
        {...(label && !selection ? { triggerLabel: label } : {})}
        triggerAriaLabel={pickerLabel}
        onInstanceModelChange={(instanceId, model) =>
          onChange(pickModelSelection(selected, instanceId, model))
        }
      />
    </div>
  );
}
