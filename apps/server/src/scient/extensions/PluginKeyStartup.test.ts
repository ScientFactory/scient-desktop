// @effect-diagnostics nodeBuiltinImport:off -- Synthetic plugin files only.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import type { ProviderPluginActions } from "../../provider/ScientProviderInstanceSeams.ts";
import { preparePluginKeyStartup } from "./PluginKeyStartup.ts";

const agent = ProviderInstanceId.make("synthetic-agent");
const provider = (driver: string): ServerProvider => ({
  instanceId: agent,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  checkedAt: "2026-10-28T00:00:00.000Z",
});
const plugin = (id: string, path?: string): ServerProviderPlugin => ({
  id,
  name: `${id}@synthetic`,
  source: "local",
  enabled: true,
  ...(path ? { path } : {}),
});
const keyPluginRoot = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-keys-"));
    await NodeFSP.writeFile(
      NodePath.join(root, ".mcp.json"),
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
    return root;
  }),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);
const actions = (
  listPlugins: ProviderPluginActions["listPlugins"],
  listPluginRoots?: ProviderPluginActions["listPluginRoots"],
) =>
  ({
    listPlugins,
    ...(listPluginRoots ? { listPluginRoots } : {}),
    readMcpServer: () => Effect.never,
    uninstall: () => Effect.void,
    startMcpSignIn: () => Effect.fail({ message: "Not used" }),
    isRetired: Effect.succeed(false),
    whenRetired: Effect.never,
  }) satisfies ProviderPluginActions;
const prepare = (driver: string, pluginActions: ProviderPluginActions) =>
  Effect.gen(function* () {
    const providers = Context.get(
      yield* Layer.build(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([provider(driver)]),
          getProviderPluginActionsForInstance: () => Effect.succeed(pluginActions),
        }),
      ),
      ProviderRegistry,
    );
    return yield* preparePluginKeyStartup(providers, agent, undefined);
  });

it.effect("starts Codex from plugin folders, rechecking fresh before preparing any key", () =>
  Effect.gen(function* () {
    const root = yield* keyPluginRoot;
    const reads: boolean[] = [];
    const policies = yield* prepare(
      "codex",
      actions(
        () => Effect.die("The catalog listing must not run before a session starts."),
        ({ fresh }) =>
          Effect.sync(() => {
            reads.push(fresh === true);
            return [
              { id: "uncached", name: "uncached", enabled: true },
              // Disabled outside Scient since the last listing: only a fresh read knows.
              { id: "keyed", name: "keyed", enabled: fresh !== true, root },
            ];
          }),
      ),
    );
    expect(policies).toEqual([]);
    expect(reads).toEqual([false, true]);
  }).pipe(Effect.scoped),
);

it.effect("starts Claude without keys for a plugin whose folder was deleted", () =>
  Effect.gen(function* () {
    const root = yield* keyPluginRoot;
    const policies = yield* prepare(
      "claudeAgent",
      actions(() =>
        Effect.succeed({
          sequence: 1,
          plugins: [plugin("deleted", NodePath.join(root, "missing")), plugin("keyed", root)],
        }),
      ),
    );
    expect(policies.map((policy) => policy.pluginId)).toEqual(["keyed@synthetic"]);
  }).pipe(Effect.scoped),
);

it.effect("starts without plugin keys when the agent cannot list its plugins", () =>
  Effect.gen(function* () {
    const policies = yield* prepare(
      "codex",
      actions(() => Effect.fail({ message: "Codex could not list its plugins." })),
    );
    expect(policies).toEqual([]);
  }),
);
