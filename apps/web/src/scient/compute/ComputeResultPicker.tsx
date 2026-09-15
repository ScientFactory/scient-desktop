import { ChevronDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { useComputeContextStore, type ComputeContextId } from "./computeContextStore";
import { useComputeFilePresentationStore } from "./computeFilePresentationStore";

/** Select retained results; never create, stop or rerun a runtime. */
export function ComputeResultPicker({ contextId }: { readonly contextId: ComputeContextId }) {
  const bindings = useComputeContextStore((state) => state.bindings);
  const selected = useComputeFilePresentationStore(
    (state) => state.presentations[contextId]?.resultsContextId ?? contextId,
  );
  const children = Object.values(bindings).filter(
    (binding) => binding.parentContextId === contextId,
  );
  if (children.length === 0) return null;
  let fresh = 0;
  let batch = 0;
  const choices = [
    { contextId, label: "Session" },
    ...children.map((binding) => ({
      contextId: binding.contextId,
      label: binding.batchRunId === undefined ? `Fresh run ${++fresh}` : `MATLAB batch ${++batch}`,
    })),
  ];
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="max-w-40 gap-1 px-1.5 text-muted-foreground"
            aria-label="Choose results"
          >
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
