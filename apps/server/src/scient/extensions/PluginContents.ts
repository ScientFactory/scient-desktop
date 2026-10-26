import {
  ExtensionsError,
  type ExtensionPluginContentsInput,
  type ExtensionSkillDocumentInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ScientPluginRegistryShape } from "./ExtensionsServices.ts";
import { readLocalPluginContents, readLocalPluginSkill } from "./LocalPluginContents.ts";

const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));
const unavailable = (message: string) =>
  new ExtensionsError({ reason: "state-unavailable", message });

export function makePluginContents(
  providers: ProviderRegistryShape,
  plugins: ScientPluginRegistryShape,
) {
  const target = Effect.fn("PluginContents.target")(function* (
    input: ExtensionPluginContentsInput,
  ) {
    if (Boolean(input.pluginId) === Boolean(input.entryId))
      return yield* unavailable("Choose one plugin.");
    if (!input.instanceId) return undefined;
    const provider = (yield* providers.getProviders).find(
      (item) => item.instanceId === input.instanceId,
    );
    if (!provider?.enabled || !provider.installed)
      return yield* unavailable("This agent is not available.");
    const actions = yield* providers.getProviderPluginActionsForInstance(input.instanceId);
    if (!actions || (yield* actions.isRetired))
      return yield* unavailable("This agent is no longer available.");
    return { provider, actions };
  });
  const localRoot = Effect.fn("PluginContents.localRoot")(function* (
    input: ExtensionPluginContentsInput,
    actions: import("../../provider/ScientProviderInstanceSeams.ts").ProviderPluginActions,
  ) {
    const listing = yield* actions.listPlugins({ cwd: input.cwd });
    const plugin = listing.plugins.find((item) => item.id === input.pluginId);
    const parsed = decodePath(plugin);
    if (parsed._tag === "None") return yield* unavailable("This plugin has no local contents.");
    return parsed.value.path;
  });
  const read = Effect.fn("PluginContents.read")(
    function* (input: ExtensionPluginContentsInput) {
      const resolved = yield* target(input);
      if (!resolved) {
        if (!input.pluginId || !plugins.contents)
          return yield* unavailable("This plugin has no contents to show.");
        return yield* plugins.contents(input.pluginId);
      }
      const { actions, provider } = resolved;
      const operation =
        input.entryId || provider.driver === "codex"
          ? actions.store?.contents?.(input.entryId ?? input.pluginId!)
          : localRoot(input, actions).pipe(
              Effect.flatMap((root) => Effect.tryPromise(() => readLocalPluginContents(root))),
            );
      if (!operation) return yield* unavailable("This agent does not expose plugin contents.");
      return yield* Effect.raceFirst(
        operation,
        actions.whenRetired.pipe(
          Effect.andThen(Effect.fail(unavailable("The agent changed. Open the plugin again."))),
        ),
      );
    },
    Effect.mapError(() => unavailable("Could not read this plugin's contents.")),
  );
  const document = Effect.fn("PluginContents.document")(
    function* (input: ExtensionSkillDocumentInput) {
      const resolved = yield* target(input);
      if (!resolved) {
        if (!input.pluginId || !plugins.skillDocument)
          return yield* unavailable("This skill has no document to show.");
        return yield* plugins.skillDocument(input.pluginId, input.skillId);
      }
      const { actions, provider } = resolved;
      const operation =
        input.entryId || provider.driver === "codex"
          ? actions.store?.skillDocument?.(input.entryId ?? input.pluginId!, input.skillId)
          : localRoot(input, actions).pipe(
              Effect.flatMap((root) =>
                Effect.tryPromise(() => readLocalPluginSkill(root, input.skillId)),
              ),
            );
      if (!operation) return yield* unavailable("This agent does not expose skill documents.");
      return yield* Effect.raceFirst(
        operation,
        actions.whenRetired.pipe(
          Effect.andThen(Effect.fail(unavailable("The agent changed. Open the skill again."))),
        ),
      );
    },
    Effect.mapError(() =>
      unavailable(
        "Could not read this skill. Its file must stay inside the plugin and be at most 256 KB.",
      ),
    ),
  );
  return { read, document };
}
