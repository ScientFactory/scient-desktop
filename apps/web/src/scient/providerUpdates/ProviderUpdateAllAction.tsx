import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { describeProviderUpdateItem, type ProviderUpdateMachine } from "./providerUpdateInventory";
import { useProviderUpdateInventory } from "./useProviderUpdateInventory";

/** Each machine, then one line per runtime it updates, with versions and owner. */
export function ProviderUpdateLines(props: {
  readonly machines: ReadonlyArray<ProviderUpdateMachine>;
}) {
  return (
    <div className="space-y-1.5 py-0.5 text-left">
      {props.machines.map((machine) => (
        <div key={machine.environmentId}>
          <p className="font-medium text-foreground">{machine.label}</p>
          {machine.items.map((item) => (
            <p className="text-muted-foreground" key={item.instanceId}>
              {describeProviderUpdateItem(item)}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Provider settings "Update all": every managed and system runtime with a
 * one-click update on every connected machine. Renders nothing when there is
 * none; stays while a run is in flight, since items leave the list as they start.
 */
export function ProviderUpdateAllAction() {
  const { machines, updateAll } = useProviderUpdateInventory();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  if (machines.length === 0 && !isPending) return null;

  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      await updateAll();
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={isPending}
            onClick={() => void handleUpdate()}
          >
            {isPending ? "Updating…" : "Update all"}
          </Button>
        }
      />
      {machines.length > 0 ? (
        <TooltipPopup className="max-w-80" side="top">
          <ProviderUpdateLines machines={machines} />
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
