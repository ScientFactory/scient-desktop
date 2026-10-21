/**
 * Grant-time authority for connectors created by Scient plugin bundles.
 *
 * The plugin registry publishes, after each committed change, the exact set of
 * connectors owned by an enabled plugin whose installed copy verified. The
 * connector runtime consults it on delivery, on every grant check and proxied
 * request, and before enabling a connector. A plugin-sourced connector outside
 * that set (an orphan, or one of a disabled or unverified plugin) is denied even
 * when its own record says enabled, so revocation never depends on a
 * successful connector write. Until the registry has published, and while its
 * state file is unreadable, every plugin-sourced connector is denied.
 *
 * This service holds no lock and calls nothing: it sits below both the
 * connector runtime and the plugin registry in the layer graph, so neither
 * depends on the other through it.
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
