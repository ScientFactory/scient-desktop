// @effect-diagnostics nodeBuiltinImport:off -- Synthetic plugin files and private binding state only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import { Effect, Context, Layer } from "effect";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import type { ConnectorRuntimeShape } from "./ExtensionsServices.ts";
import { makeHarness, syntheticValue } from "../accounts/Accounts.testkit.ts";
import { accountTokenRef } from "../accounts/AccountBoundRef.ts";
import { makePluginKeyBindings } from "./PluginKeyBindings.ts";
import { preparePluginKeyHttpDelivery } from "./PluginKeyHttpDelivery.ts";
import { preparePluginKeyStartup } from "./PluginKeyStartup.ts";

type Registration = Parameters<NonNullable<ConnectorRuntimeShape["registerPluginKeyHttp"]>>[0];
const agent = ProviderInstanceId.make("synthetic-agent");
const projectId = ProjectId.make("synthetic-project");
const provider: ServerProvider = {
  instanceId: agent,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  checkedAt: "2026-10-27T00:00:00.000Z",
};

it.effect(
  "injects current bound headers and refuses revoked accounts, changed sources and another agent",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-http-")),
        ),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const pluginRoot = NodePath.join(root, "plugin");
      const manifest = NodePath.join(pluginRoot, ".mcp.json");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(pluginRoot);
        await NodeFSP.writeFile(
          manifest,
          JSON.stringify({
            mcpServers: {
              api: {
                type: "http",
                url: "https://api.example.com/mcp",
                headers: { Authorization: "Bearer ${TOKEN}" },
              },
            },
          }),
        );
      });
      let enabled = true;
      const actions: ProviderPluginActions = {
        listPlugins: () =>
          Effect.succeed({
            sequence: 1,
            plugins: [
              {
                id: "native-plugin-id",
                name: "sample@synthetic",
                source: "local",
                enabled,
                path: pluginRoot,
              },
            ],
          }),
        readMcpServer: () => Effect.never,
        uninstall: () => Effect.void,
        startMcpSignIn: () => Effect.fail({ message: "Not used" }),
        isRetired: Effect.succeed(false),
        whenRetired: Effect.never,
      };
      const providers = Context.get(
        yield* Layer.build(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([provider]),
            getProviderPluginActionsForInstance: () => Effect.succeed(actions),
          }),
        ),
        ProviderRegistry,
      );
      const { service } = yield* makeHarness();
      const original = syntheticValue();
      const details = {
        kind: "api-key" as const,
        sites: ["example.com"],
        auth: { type: "bearer" as const },
      };
      const { accountId } = yield* service.save({
        name: "Synthetic API",
        details,
        secrets: { token: { type: "scient", value: original } },
      });
      let listCalls = 0;
      let resolveCalls = 0;
      const bindings = yield* makePluginKeyBindings(root, {
        ...service,
        listBindable: (input) => {
          listCalls++;
          return service.listBindable(input);
        },
        resolveBound: (ref, consumer, options) => {
          resolveCalls++;
          return service.resolveBound(ref, consumer, options);
        },
      });
      const registrations: Registration[] = [];
      const runtime = {
        registerPluginKeyHttp: (registration: Registration) =>
          Effect.sync(() => {
            registrations.push(registration);
            return {
              connectorId: registration.connectorId,
              serverName: registration.serverName,
              displayName: registration.displayName,
            };
          }),
      };
      const policies = yield* preparePluginKeyStartup(providers, agent, pluginRoot);
      const input = { agent, projectId, cwd: pluginRoot, policies };
      expect(
        (yield* preparePluginKeyHttpDelivery(providers, runtime, bindings, input)).connectors,
      ).toHaveLength(0);
      yield* bindings.bind({
        agent,
        pluginId: "native-plugin-id",
        envName: "TOKEN",
        accountRef: accountTokenRef(accountId),
      });
      const delivery = yield* preparePluginKeyHttpDelivery(providers, runtime, bindings, input);
      expect(Object.values(delivery.serverNames)).toEqual(["plugin:sample:api"]);
      expect(JSON.stringify(delivery).includes(original)).toBe(false);
      const registered = registrations[0]!;
      const scope: McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("synthetic"),
        capabilities: new Set(),
        requestNamespace: "synthetic",
        issuedAt: 0,
        client: undefined,
        thread: {
          threadId: ThreadId.make("synthetic-thread"),
          providerSessionId: "synthetic-session",
          providerInstanceId: agent,
        },
        connectorIds: new Set([registered.connectorId]),
      };
      expect((yield* registered.authorize(scope)).headers).toEqual({
        Authorization: `Bearer ${original}`,
      });
      const initialLists = listCalls;
      const initialResolves = resolveCalls;
      const warm = yield* Effect.forEach(
        Array.from({ length: 20 }),
        () => registered.authorize(scope),
        { concurrency: "unbounded" },
      );
      expect(
        warm.every((response) => response.headers.Authorization === `Bearer ${original}`),
      ).toBe(true);
      expect(listCalls).toBe(initialLists);
      expect(resolveCalls).toBe(initialResolves);
      const replacement = syntheticValue();
      yield* service.save({
        accountId,
        name: "Synthetic API",
        details,
        secrets: { token: { type: "scient", value: replacement } },
      });
      expect((yield* registered.authorize(scope)).headers).toEqual({
        Authorization: `Bearer ${replacement}`,
      });
      const another = yield* service.save({
        name: "Another synthetic API",
        details,
        secrets: { token: { type: "scient", value: syntheticValue() } },
      });
      yield* bindings.bind({
        agent,
        pluginId: "native-plugin-id",
        envName: "TOKEN",
        accountRef: accountTokenRef(another.accountId),
      });
      expect((yield* registered.authorize(scope).pipe(Effect.result))._tag).toBe("Failure");
      const rebound = yield* preparePluginKeyHttpDelivery(providers, runtime, bindings, input);
      expect(rebound.connectors[0]?.connectorId).not.toBe(delivery.connectors[0]?.connectorId);
      yield* bindings.bind({
        agent,
        pluginId: "native-plugin-id",
        envName: "TOKEN",
        accountRef: accountTokenRef(accountId),
      });

      expect(
        (yield* registered
          .authorize({
            ...scope,
            thread: { ...scope.thread, providerInstanceId: ProviderInstanceId.make("other-agent") },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* service.setAgentAccess(false);
      expect((yield* registered.authorize(scope).pipe(Effect.result))._tag).toBe("Failure");
      yield* service.setAgentAccess(true);
      enabled = false;
      expect((yield* registered.authorize(scope).pipe(Effect.result))._tag).toBe("Failure");
      enabled = true;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          manifest,
          JSON.stringify({
            mcpServers: {
              api: {
                type: "http",
                url: "https://other.example.com/mcp",
                headers: { Authorization: "Bearer ${TOKEN}" },
              },
            },
          }),
        ),
      );
      expect((yield* registered.authorize(scope).pipe(Effect.result))._tag).toBe("Failure");
    }),
);
