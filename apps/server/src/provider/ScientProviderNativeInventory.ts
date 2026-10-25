/**
 * Keep the last native inventory per instance generation so status probes cannot erase fields they
 * cannot observe. Order each machine/workspace scope by read start time, preventing slow reads from
 * replacing newer results; never persist this overlay in the status cache.
 */
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderNativeInventory } from "./ScientProviderInstanceSeams.ts";

interface Ordered<A> {
  readonly value: A;
  readonly sequence: number;
}

interface Entry {
  /** The instance generation that reported this inventory. */
  readonly owner: object;
  readonly plugins?: Ordered<NonNullable<ProviderNativeInventory["plugins"]>>;
  readonly mcpServers?: Ordered<NonNullable<ProviderNativeInventory["mcpServers"]>>;
  /** Per workspace, when the last applied listing or scan began. */
  readonly workspaceFloors: ReadonlyMap<string, number>;
}

/** The parts of a report that were newer than what their scope already has. */
export interface AcceptedNativeInventory {
  readonly machine?: Pick<ProviderNativeInventory, "plugins" | "mcpServers">;
  readonly workspace?: {
    readonly cwd: string;
    readonly plugins: NonNullable<ProviderNativeInventory["plugins"]>;
  };
}

const isNewer = (sequence: number, applied: { readonly sequence: number } | undefined) =>
  applied === undefined || sequence > applied.sequence;

type Entries = ReadonlyMap<ProviderInstanceId, Entry>;

export const makeScientProviderNativeInventory = Effect.gen(function* () {
  const entriesRef = yield* Ref.make<Entries>(new Map());

  const entryFor = (entries: Entries, instanceId: ProviderInstanceId, owner: object): Entry => {
    const entry = entries.get(instanceId);
    return entry?.owner === owner ? entry : { owner, workspaceFloors: new Map() };
  };

  /** Records the fields of `report` that are newer than their scope's last applied read. */
  const accept = (
    instanceId: ProviderInstanceId,
    owner: object,
    report: ProviderNativeInventory,
    sequence: number,
  ) =>
    Ref.modify(entriesRef, (entries: Entries): readonly [AcceptedNativeInventory, Entries] => {
      const entry = entryFor(entries, instanceId, owner);
      if (report.cwd !== undefined) {
        const floor = entry.workspaceFloors.get(report.cwd);
        if (!report.plugins || (floor !== undefined && sequence <= floor)) return [{}, entries];
        const next = new Map(entries).set(instanceId, {
          ...entry,
          workspaceFloors: new Map(entry.workspaceFloors).set(report.cwd, sequence),
        });
        return [{ workspace: { cwd: report.cwd, plugins: report.plugins } }, next];
      }
      const plugins =
        report.plugins && isNewer(sequence, entry.plugins) ? report.plugins : undefined;
      const mcpServers =
        report.mcpServers && isNewer(sequence, entry.mcpServers) ? report.mcpServers : undefined;
      if (!plugins && !mcpServers) return [{}, entries];
      const next = new Map(entries).set(instanceId, {
        ...entry,
        ...(plugins && { plugins: { value: plugins, sequence } }),
        ...(mcpServers && { mcpServers: { value: mcpServers, sequence } }),
      });
      return [
        { machine: { ...(plugins && { plugins }), ...(mcpServers && { mcpServers }) } },
        next,
      ];
    });

  /**
   * A workspace scan began at `sequence`: listings of that workspace that
   * began earlier, including ones from before the workspace was evicted and
   * scanned again, no longer apply.
   */
  const markWorkspaceScan = (
    instanceId: ProviderInstanceId,
    owner: object,
    cwd: string,
    sequence: number,
  ) =>
    Ref.update(entriesRef, (entries) => {
      const entry = entryFor(entries, instanceId, owner);
      if ((entry.workspaceFloors.get(cwd) ?? -1) >= sequence) return entries;
      return new Map(entries).set(instanceId, {
        ...entry,
        workspaceFloors: new Map(entry.workspaceFloors).set(cwd, sequence),
      });
    });

  /** The machine inventory reported by `owner`; nothing for any other generation. */
  const read = (instanceId: ProviderInstanceId, owner: object | undefined) =>
    Ref.get(entriesRef).pipe(
      Effect.map((entries): ProviderNativeInventory | undefined => {
        const entry = entries.get(instanceId);
        if (!entry || entry.owner !== owner) return undefined;
        return {
          ...(entry.plugins && { plugins: entry.plugins.value }),
          ...(entry.mcpServers && { mcpServers: entry.mcpServers.value }),
        };
      }),
    );

  /** Drops the inventory of instances whose generation is gone. */
  const forget = (keep: (instanceId: ProviderInstanceId) => boolean) =>
    Ref.update(entriesRef, (previous) => {
      const next = new Map(previous);
      for (const instanceId of previous.keys()) {
        if (!keep(instanceId)) next.delete(instanceId);
      }
      return next.size === previous.size ? previous : next;
    });

  return { accept, markWorkspaceScan, read, forget };
});

export function overlayProviderNativeInventory(
  provider: ServerProvider,
  inventory: ProviderNativeInventory | undefined,
): ServerProvider {
  if (!inventory) return provider;
  return {
    ...provider,
    ...(inventory.plugins && { plugins: inventory.plugins }),
    ...(inventory.mcpServers && { mcpServers: inventory.mcpServers }),
  };
}

/**
 * Snapshot without provider-native inventory. Used for the status cache and
 * when an instance is rebuilt, since a new configuration may see a different
 * inventory.
 */
export function withoutProviderNativeInventory(provider: ServerProvider): ServerProvider {
  const { plugins: _plugins, mcpServers: _mcpServers, ...rest } = provider;
  return rest;
}
