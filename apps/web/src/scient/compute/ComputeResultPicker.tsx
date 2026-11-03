import { ChevronDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { useClientSettings } from "~/hooks/useSettings";
import { formatTimestamp } from "~/timestampFormat";
import { useComputeContextStore, type ComputeContextId } from "./computeContextStore";
import { useComputeFilePresentationStore } from "./computeFilePresentationStore";

/** Session feed or a MATLAB run; Run fresh runs already appear in the feed. */
export function ComputeResultPicker({ contextId }: { readonly contextId: ComputeContextId }) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const bindings = useComputeContextStore((state) => state.bindings);
  const selected = useComputeFilePresentationStore(
    (state) => state.presentations[contextId]?.resultsContextId ?? contextId,
  );
  const batches = Object.values(bindings).filter(
    (binding) => binding.parentContextId === contextId && binding.batchRunId !== undefined,
  );
  if (batches.length === 0) return null;
  const choices = [
    { contextId, label: "Session" },
    ...batches.map((binding, index) => ({
      contextId: binding.contextId,
      label:
        binding.startedAt === undefined
          ? `Run ${index + 1}`
          : formatTimestamp(binding.startedAt, timestampFormat),
    })),
  ];
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost-muted" className="max-w-40" aria-label="Choose results">
            <span className="truncate">
              {choices.find((choice) => choice.contextId === selected)?.label ?? "Session"}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      />
      <MenuPopup align="start" className="max-h-64 overflow-y-auto">
        <MenuRadioGroup
          value={selected}
          onValueChange={(value) => {
            const choice = choices.find((candidate) => candidate.contextId === value);
            if (choice)
              useComputeFilePresentationStore
                .getState()
                .setResultsContext(
                  contextId,
                  choice.contextId === contextId ? null : choice.contextId,
                );
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.contextId} value={choice.contextId}>
              {choice.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
