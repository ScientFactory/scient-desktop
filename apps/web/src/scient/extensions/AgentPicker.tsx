import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { cloneElement, useState, type ReactElement } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import { connectorsReach, providerAvailable, worksWithOptions } from "./extensionsView";

export interface ConnectorAgent {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly provider: ServerProvider | undefined;
}

/**
 * The agents this person has that can take Scient connectors: installed, turned on and ready,
 * in the order the environment lists them. Agents Scient merely knows about are left out.
 */
export function useConnectorAgents(): ReadonlyArray<ConnectorAgent> {
  const { inventory, providers } = useExtensionsEnvironment();
  return worksWithOptions(inventory?.providerSupport ?? [], providers).flatMap((option) => {
    const provider = providers.find((candidate) => candidate.instanceId === option.instanceId);
    return provider && providerAvailable(provider) && connectorsReach(option)
      ? [{ instanceId: option.instanceId, label: option.label, provider }]
      : [];
  });
}

/** The chosen agents as the add request takes them: none means every agent. */
function chosenAgents(
  agents: ReadonlyArray<ConnectorAgent>,
  chosen: ReadonlySet<ProviderInstanceId>,
): ReadonlyArray<ProviderInstanceId> | undefined {
  return agents.every((agent) => chosen.has(agent.instanceId))
    ? undefined
    : agents.filter((agent) => chosen.has(agent.instanceId)).map((agent) => agent.instanceId);
}

function AgentIcon({ agent }: { readonly agent: ConnectorAgent }) {
  return agent.provider ? (
    <ProviderInstanceIcon
      driverKind={agent.provider.driver}
      displayName={agent.label}
      acpRegistryIconUrl={agent.provider.iconUrl}
      iconClassName="size-4"
    />
  ) : null;
}

/**
 * The add button of something Scient gives to agents. With more than one agent that takes it, it
 * opens a small card to choose which ones, every agent ticked to start; with one, it adds at once.
 */
export function AddForAgents({
  name,
  trigger,
  disabled,
  onAdd,
}: {
  readonly name: string;
  /** The button, without its click handler. */
  readonly trigger: ReactElement<{ disabled?: boolean; onClick?: () => void }>;
  readonly disabled: boolean;
  /** Called with the chosen agents; undefined when every agent was chosen. */
  readonly onAdd: (agents: ReadonlyArray<ProviderInstanceId> | undefined) => void;
}) {
  const gt = useGT();
  const agents = useConnectorAgents();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<ProviderInstanceId>>(new Set());
  if (agents.length <= 1) {
    return cloneElement(trigger, { disabled, onClick: () => onAdd(undefined) });
  }
  const toggle = (instanceId: ProviderInstanceId, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setChosen(new Set(agents.map((agent) => agent.instanceId)));
        setOpen(next);
      }}
    >
      <PopoverTrigger disabled={disabled} render={trigger} />
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        padding="comfortable"
        aria-label={gt("Add {name} for", { name })}
        className="w-64"
      >
        <div className="grid gap-3">
          <p className="text-sm font-medium text-foreground">
            <T>
              Add <Var>{name}</Var> for
            </T>
          </p>
          <ul className="grid gap-1">
            {agents.map((agent) => {
              const checked = chosen.has(agent.instanceId);
              return (
                <li key={agent.instanceId}>
                  <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-sm text-foreground hover:bg-foreground/[0.045]">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => toggle(agent.instanceId, next === true)}
                    />
                    <AgentIcon agent={agent} />
                    <span className="min-w-0 truncate">{agent.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <Button
            size="sm"
            disabled={chosen.size === 0}
            onClick={() => {
              setOpen(false);
              onAdd(chosenAgents(agents, chosen));
            }}
          >
            {chosen.size === 0
              ? gt("Choose an agent")
              : gt("Add", { $context: "verb, adds an extension" })}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
