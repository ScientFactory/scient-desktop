import type { EnvironmentId } from "@t3tools/contracts";

import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";

import {
  describeProviderUpdateItem,
  type ProviderUpdateMachine,
} from "../providerUpdates/providerUpdateInventory";

/**
 * The sidebar update button when it updates providers and servers rather than
 * this app. Built from the theme's own sidebar colours, so every theme,
 * including custom and imported ones, keeps its contrast; the app's update
 * keeps the theme's primary action colour. The outline is a border, so the
 * button's keyboard focus ring keeps its own colour.
 */
export const SHARED_UPDATE_BUTTON_CLASS =
  "border border-sidebar-border bg-sidebar-control-surface text-sidebar-foreground";
export const SHARED_UPDATE_BUTTON_HOVER_CLASS = "hover:bg-sidebar-row-hover";

/**
 * A Restart tooltip that also says what can update once the app is back:
 * "… Restart to install. Then update 1 server and 2 providers."
 */
export function withUpdatesAfterRestart(tooltip: string, remoteSummary: string | null): string {
  if (!remoteSummary) return tooltip;
  const then = remoteSummary.charAt(0).toLowerCase() + remoteSummary.slice(1);
  return `${tooltip.replace(/\.?$/u, ".")} Then ${then}.`;
}

export interface UpdateEverythingDetail {
  readonly key: string;
  readonly label: string;
  readonly items: ReadonlyArray<string>;
}

/** This app first, then each machine with one line per server or provider it updates. */
export function describeUpdateEverythingDetails(input: {
  readonly localVersion: string | null;
  readonly servers: ReadonlyArray<
    Pick<ServerUpdateTarget, "environmentId" | "serverLabel" | "selfUpdate" | "targetVersion">
  >;
  readonly providerMachines: ReadonlyArray<ProviderUpdateMachine>;
}): UpdateEverythingDetail[] {
  const machines = new Map<EnvironmentId, { label: string; items: string[] }>();
  const itemsFor = (environmentId: EnvironmentId, label: string) => {
    const machine = machines.get(environmentId) ?? { label, items: [] };
    machines.set(environmentId, machine);
    return machine.items;
  };
  for (const server of input.servers) {
    itemsFor(server.environmentId, server.serverLabel).push(
      server.selfUpdate === "desktop-managed"
        ? "Desktop app update"
        : `Server → ${server.targetVersion}`,
    );
  }
  for (const machine of input.providerMachines) {
    itemsFor(machine.environmentId, machine.label).push(
      ...machine.items.map(describeProviderUpdateItem),
    );
  }
  return [
    ...(input.localVersion
      ? [{ key: "this-app", label: "This app", items: [`${input.localVersion} · restarts last`] }]
      : []),
    ...Array.from(machines, ([environmentId, { label, items }]) => ({
      key: environmentId,
      label,
      items,
    })),
  ];
}

/** The tooltip for "update everything": its summary, then what each machine updates. */
export function UpdateEverythingTooltip(props: {
  readonly summary: string;
  readonly details: ReadonlyArray<UpdateEverythingDetail>;
}) {
  return (
    <div className="space-y-1.5 py-0.5 text-left">
      <p className="font-medium text-foreground">{props.summary}</p>
      {props.details.map((detail) => (
        <div key={detail.key}>
          <p className="text-foreground">{detail.label}</p>
          {detail.items.map((item) => (
            <p className="text-muted-foreground" key={item}>
              {item}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
