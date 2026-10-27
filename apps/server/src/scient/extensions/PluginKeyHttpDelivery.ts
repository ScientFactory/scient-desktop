// @effect-diagnostics nodeBuiltinImport:off -- Non-secret registration identities bind source configuration and session scope.
import * as NodeCrypto from "node:crypto";
import {
  ConnectorId,
  isReservedConnectorServerName,
  ExtensionsError,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";
import type { ConnectorRuntimeShape, EligibleConnector } from "./ExtensionsServices.ts";
import type { PluginKeyBindings } from "./PluginKeyBindings.ts";
import { readLocalPluginContents, readLocalPluginKeyHttpServers } from "./LocalPluginContents.ts";
import { pluginKeyHttpOrigins } from "./PluginKeyHttpServers.ts";
import type { PluginKeyHttpServer } from "./PluginKeyHttpServers.ts";
const pathOf = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));
const fingerprint = (input: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
const denied = () =>
  new ExtensionsError({
    reason: "state-unavailable",
    message: "This plugin server or its bound account is no longer available.",
  });

export const preparePluginKeyHttpDelivery = Effect.fn("PluginKeyHttpDelivery.prepare")(function* (
  providers: ProviderRegistryShape,
  runtime: Pick<ConnectorRuntimeShape, "registerPluginKeyHttp">,
  bindings: PluginKeyBindings["Service"],
  input: {
    readonly agent: ProviderInstanceId;
    readonly projectId: ProjectId | undefined;
    readonly cwd: string | undefined;
    readonly policies: ReadonlyArray<McpPluginKeyPolicy>;
  },
) {
  const provider = (yield* providers.getProviders).find(
    (provider) => provider.instanceId === input.agent,
  );
  const connectors: EligibleConnector[] = [];
  const serverNames: Record<string, string> = {};
  if (
    !runtime.registerPluginKeyHttp ||
    !provider ||
    (provider.driver !== "claudeAgent" && provider.driver !== "codex")
  )
    return { connectors, serverNames };
  for (const policy of input.policies) {
    if (!policy.path) continue;
    const root = policy.path;
    const target = {
      agent: input.agent,
      pluginId: policy.bindingPluginId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const servers = yield* Effect.tryPromise(() => readLocalPluginKeyHttpServers(root));
    const initialEligibility = yield* bindings.list(
      target,
      policy.requiredKeys,
      pluginKeyHttpOrigins(servers),
    );
    if (initialEligibility.status !== "ready") continue;
    const expectedRefs = new Map(
      initialEligibility.keys.map((key) => [key.envName, key.accountRef]),
    );
    const bindingIdentity = fingerprint(
      initialEligibility.keys.map((key) => [key.envName, key.accountRef]),
    );
    for (const server of servers) {
      if (provider.driver === "codex" && isReservedConnectorServerName(server.name)) continue;
      const origin = new URL(server.url).origin;
      const originAllowed = yield* Effect.forEach(server.envNames, (envName) =>
        bindings.resolveKey({ ...target, envName, origin, expectedRef: expectedRefs.get(envName) }),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!originAllowed) continue;
      const generation = fingerprint([
        input.agent,
        input.projectId ?? null,
        policy.bindingPluginId,
        bindingIdentity,
        root,
        server,
      ]);
      const alias = `pkey-${generation.slice(0, 24)}`;
      const nativeName =
        provider.driver === "claudeAgent"
          ? `plugin:${policy.pluginName}:${server.name}`
          : server.name;
      if (
        provider.driver === "codex" &&
        provider.mcpServers?.some(
          (native) => native.name === nativeName && native.pluginId !== policy.bindingPluginId,
        )
      )
        continue;
      if (Object.values(serverNames).includes(nativeName)) return yield* denied();
      const authorize = Effect.fn("PluginKeyHttpDelivery.authorize")(function* (
        scope: Parameters<
          Parameters<NonNullable<ConnectorRuntimeShape["registerPluginKeyHttp"]>>[0]["authorize"]
        >[0],
      ) {
        if (scope?.thread?.providerInstanceId !== input.agent) return yield* denied();
        const actions = yield* providers.getProviderPluginActionsForInstance(input.agent);
        if (!actions || (yield* actions.isRetired)) return yield* denied();
        const current = (yield* actions.listPlugins(
          input.cwd ? { cwd: input.cwd } : {},
        )).plugins.find((plugin) => plugin.id === policy.bindingPluginId && plugin.enabled);
        if (!current) return yield* denied();
        const parsed = pathOf(current);
        const currentRoot =
          parsed._tag === "Some"
            ? parsed.value.path
            : yield* actions.store?.keyServerRoot?.(current.id) ?? Effect.void;
        if (currentRoot !== root) return yield* denied();
        const contents = yield* Effect.tryPromise(() => readLocalPluginContents(root));
        const eligibility = yield* bindings.list(target, contents.requiredKeys);
        if (
          eligibility.status !== "ready" ||
          fingerprint(eligibility.keys.map((key) => [key.envName, key.accountRef])) !==
            bindingIdentity
        )
          return yield* denied();
        const fresh = (yield* Effect.tryPromise(() => readLocalPluginKeyHttpServers(root))).find(
          (candidate) => candidate.name === server.name,
        );
        if (
          !fresh ||
          fingerprint([
            input.agent,
            input.projectId ?? null,
            policy.bindingPluginId,
            bindingIdentity,
            root,
            fresh,
          ]) !== generation
        )
          return yield* denied();
        return yield* injectPluginKeyHeaders(fresh, (envName) =>
          bindings.resolveKey({
            ...target,
            envName,
            origin,
            expectedRef: expectedRefs.get(envName),
          }),
        );
      }, Effect.mapError(denied));
      connectors.push(
        yield* runtime.registerPluginKeyHttp({
          connectorId: ConnectorId.make(`con_pk${generation.slice(0, 32)}`),
          serverName: alias,
          displayName: `${policy.pluginName}: ${server.name}`,
          url: server.url,
          projectId: input.projectId,
          authorize,
        }),
      );
      serverNames[alias] = nativeName;
    }
  }
  return { connectors, serverNames };
}, Effect.orDie);

const injectPluginKeyHeaders = Effect.fn("PluginKeyHttpDelivery.injectHeaders")(function* (
  server: PluginKeyHttpServer,
  resolve: (envName: string) => Effect.Effect<Redacted.Redacted<string>, ExtensionsError>,
) {
  const values = new Map<string, string>();
  for (const name of server.envNames) {
    const value = Redacted.value(yield* resolve(name));
    if (/[\r\n\0]/.test(value)) return yield* denied();
    values.set(name, value);
  }
  const headers = Object.fromEntries(
    Object.entries(server.headers).map(([name, template]) => [
      name,
      template.replace(
        /\$\{(?:user_config\.)?([A-Za-z_][A-Za-z0-9_]{0,127})\}/g,
        (_match, variable: string) => values.get(variable) ?? "",
      ),
    ]),
  );
  return { headers, secrets: [...values.values()] };
});
