/**
 * Deny plugin connectors outside committed enabled/verified ownership even if their own record
 * remains enabled; revocation cannot depend on a successful connector write. Before publication or
 * on unreadable registry state, deny all. Keep this lock-free seam below both owners to avoid
 * dependency cycles.
 */
import type { ConnectorId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface PluginConnectorEligibilityShape {
  /**
   * `pluginId` is the connector record's `source.pluginId` when its source is
   * a plugin, otherwise `undefined`; connectors not sourced from a plugin are
   * always eligible here.
   */
  readonly isEligible: (input: {
    readonly connectorId: ConnectorId;
    readonly pluginId: string | undefined;
  }) => Effect.Effect<boolean>;
  /**
   * Called only by the plugin registry. `undefined` means ownership is unknown
   * (not yet loaded, or the plugin state file is unreadable).
   */
  readonly publish: (eligible: ReadonlySet<ConnectorId> | undefined) => Effect.Effect<void>;
}

export class PluginConnectorEligibility extends Context.Service<
  PluginConnectorEligibility,
  PluginConnectorEligibilityShape
>()("t3/scient/extensions/plugins/PluginConnectorEligibility") {}

const make = Effect.gen(function* () {
  const eligible = yield* Ref.make<ReadonlySet<ConnectorId> | undefined>(undefined);
  return PluginConnectorEligibility.of({
    isEligible: ({ connectorId, pluginId }) =>
      pluginId === undefined
        ? Effect.succeed(true)
        : Ref.get(eligible).pipe(Effect.map((set) => set?.has(connectorId) ?? false)),
    publish: (next) => Ref.set(eligible, next),
  });
});

/** Provide once, beneath both `ConnectorRuntime` and `ScientPluginRegistry`. */
export const layer = Layer.effect(PluginConnectorEligibility, make);
