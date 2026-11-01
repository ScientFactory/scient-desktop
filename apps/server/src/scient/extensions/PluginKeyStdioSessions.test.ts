// @effect-diagnostics nodeBuiltinImport:off -- Synthetic subprocess and private-file lifecycle witnesses.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestClock from "effect/testing/TestClock";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { makeHarness } from "../accounts/Accounts.testkit.ts";
import { accountTokenRef } from "../accounts/AccountBoundRef.ts";
import { makePluginKeyBindings } from "./PluginKeyBindings.ts";
import { makePluginKeyStdioSessions, preparePluginKeyStdio } from "./PluginKeyStdioSessions.ts";
import { readLocalPluginKeyCommandLineBlocked } from "./LocalPluginContents.ts";
import { pluginKeyHasSecretArgs, pluginKeyStdioServer } from "./PluginKeyStdioServers.ts";
const run = NodeUtil.promisify(NodeChildProcess.execFile);
const temp = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-stdio-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

it.effect("execs with the bound env, preserves literal argv and consumes its 0600 envelope", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    const files = yield* makePluginKeyStdioSessions(root);
    const payload = JSON.stringify({
      command: process.execPath,
      args: [
        "-e",
        "console.error(process.env.SYNTHETIC_TOKEN);console.log(JSON.stringify({token:process.env.SYNTHETIC_TOKEN,args:process.argv.slice(1),electron:process.env.ELECTRON_RUN_AS_NODE}))",
        "literal space",
        "--literal=$VALUE",
      ],
      env: { SYNTHETIC_TOKEN: "synthetic-only-token" },
    });
    const [config] = yield* files.write("thread", "credential", [
      { serverName: "synthetic", contents: Redacted.make(payload) },
    ]);
    expect(JSON.stringify(config)).not.toContain("synthetic-only-token");
    const envelope = config!.args[1]!;
    expect((yield* Effect.promise(() => NodeFSP.stat(envelope))).mode & 0o777).toBe(0o600);
    expect(
      (yield* Effect.promise(() => NodeFSP.stat(NodePath.dirname(envelope)))).mode & 0o777,
    ).toBe(0o700);
    const result = yield* Effect.promise(() =>
      run(config!.command, [...config!.args], {
        env: { PATH: NodePath.dirname(process.execPath), ...config!.env },
      }),
    );
    expect(JSON.parse(result.stdout)).toEqual({
      token: "synthetic-only-token",
      args: ["literal space", "--literal=$VALUE"],
    });
    expect(result.stderr).toBe("");
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(envelope).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    yield* files.clear("credential");
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(config!.args[0]!).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  }),
);

it.effect("refuses missing and non-private files; cleans abandoned session files on startup", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    const files = yield* makePluginKeyStdioSessions(root);
    const [config] = yield* files.write("thread", "credential", [
      {
        serverName: "synthetic",
        contents: Redacted.make(
          JSON.stringify({
            command: process.execPath,
            args: ["-e", "throw Error('must not run')"],
            env: {},
          }),
        ),
      },
    ]);
    const file = config!.args[1]!;
    yield* Effect.promise(() => NodeFSP.chmod(file, 0o644));
    const invoke = () =>
      run(config!.command, [...config!.args], { env: { ...config!.env } }).then(
        () => "started",
        (error) => String(error.stderr),
      );
    expect(yield* Effect.promise(invoke)).toBe("Scient plugin server could not start.\n");
    yield* Effect.promise(() => NodeFSP.rm(file));
    const target = NodePath.join(root, "synthetic-symlink-target");
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(target, "synthetic-only", { mode: 0o600 });
      await NodeFSP.symlink(target, file);
    });
    expect(yield* Effect.promise(invoke)).toBe("Scient plugin server could not start.\n");
    yield* Effect.promise(() => NodeFSP.rm(file));
    expect(yield* Effect.promise(() => NodeFSP.readFile(target, "utf8"))).toBe("synthetic-only");
    expect(yield* Effect.promise(invoke)).toBe("Scient plugin server could not start.\n");
    yield* Effect.promise(() => NodeFSP.utimes(config!.args[0]!, 1, 1));
    yield* TestClock.setTime(24 * 60 * 60 * 1000 + 1001);
    yield* makePluginKeyStdioSessions(root);
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(config!.args[0]!).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    yield* files.clear("credential");
  }),
);

it.effect("withholds unbound and disabled accounts and refuses secret-bearing arguments", () =>
  Effect.gen(function* () {
    const root = yield* temp;
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            api: { command: process.execPath, args: ["literal"], env: { TOKEN: "${TOKEN}" } },
          },
        }),
      ),
    );
    const agent = ProviderInstanceId.make("synthetic-agent");
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
      checkedAt: "2026-10-27T00:00:00Z",
    };
    const providers = Context.get(
      yield* Layer.build(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      ),
      ProviderRegistry,
    );
    const { service } = yield* makeHarness();
    const bindings = yield* makePluginKeyBindings(root, service);
    const policy = {
      pluginId: "sample",
      bindingPluginId: "sample",
      requiredKeys: ["TOKEN"],
      pluginName: "sample",
      path: root,
      serverNames: ["api"],
    };
    const input = { agent, projectId: undefined, policies: [policy] };
    expect(yield* preparePluginKeyStdio(providers, bindings, input)).toEqual([]);
    const { accountId } = yield* service.save({
      name: "Synthetic",
      details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
      secrets: { token: { type: "scient", value: "synthetic-token" } },
    });
    yield* bindings.bind({
      agent,
      pluginId: "sample",
      envName: "TOKEN",
      accountRef: accountTokenRef(accountId),
    });
    const ready = yield* preparePluginKeyStdio(providers, bindings, input);
    expect(ready).toHaveLength(1);
    expect(JSON.parse(Redacted.value(ready[0]!.contents)).env).toEqual({
      TOKEN: "synthetic-token",
    });
    expect(
      yield* preparePluginKeyStdio(providers, bindings, input).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      ),
    ).toEqual([]);
    expect(
      yield* preparePluginKeyStdio(providers, bindings, input).pipe(
        Effect.provideService(HostProcess.IsExecutable, true),
      ),
    ).toEqual([]);
    yield* service.setAgentAccess(false);
    expect(yield* preparePluginKeyStdio(providers, bindings, input)).toEqual([]);
    yield* service.setAgentAccess(true);
    yield* bindings.unbind({ agent, pluginId: "sample", envName: "TOKEN" });
    expect(yield* preparePluginKeyStdio(providers, bindings, input)).toEqual([]);
    yield* bindings.bind({
      agent,
      pluginId: "sample",
      envName: "TOKEN",
      accountRef: accountTokenRef(accountId),
    });
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            api: { command: "server", args: ["--key=${TOKEN}"], env: { TOKEN: "${TOKEN}" } },
          },
        }),
      ),
    );
    expect(yield* Effect.promise(() => readLocalPluginKeyCommandLineBlocked(root))).toBe(true);
    expect(yield* preparePluginKeyStdio(providers, bindings, input)).toEqual([]);
    expect(
      pluginKeyStdioServer(
        "api",
        { command: "server", args: ["--key=${TOKEN}"], env: { TOKEN: "${TOKEN}" } },
        root,
      ),
    ).toBeUndefined();
    expect(pluginKeyHasSecretArgs({ command: "server", args: ["--key=${TOKEN}"] })).toBe(true);
    // A shell would expand the key into the server's argv.
    const viaShell = {
      command: "/bin/sh",
      args: ["-c", 'exec server --token "$API_KEY"'],
      env: { API_KEY: "" },
    };
    expect(pluginKeyStdioServer("api", viaShell, root)).toBeUndefined();
    expect(pluginKeyHasSecretArgs(viaShell)).toBe(true);
    expect(
      pluginKeyHasSecretArgs({
        command: "cmd",
        args: ["/c", "server %API_KEY%"],
        env: { API_KEY: "" },
      }),
    ).toBe(true);
    expect(
      pluginKeyStdioServer(
        "api",
        {
          command: "${CLAUDE_PLUGIN_ROOT}/server",
          args: ["literal space"],
          env: { TOKEN: "${TOKEN}" },
        },
        root,
      )?.command,
    ).toBe(`${root}/server`);
  }),
);

it.effect(
  "scope shutdown removes an unused envelope and its launcher without touching another owner",
  () =>
    Effect.gen(function* () {
      const root = yield* temp;
      const payload = Redacted.make(
        JSON.stringify({
          command: "synthetic-command",
          args: [],
          env: { TOKEN: "synthetic-only" },
        }),
      );
      const outer = yield* makePluginKeyStdioSessions(root);
      const [other] = yield* outer.write("thread", "other-session", [
        { serverName: "other", contents: payload },
      ]);
      const scoped = yield* Effect.scoped(
        Effect.gen(function* () {
          const files = yield* makePluginKeyStdioSessions(root);
          const [config] = yield* files.write("thread", "ended-session", [
            { serverName: "ended", contents: payload },
          ]);
          return config!;
        }),
      );
      for (const file of scoped.args)
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(file).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(other!.args[1]!).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(true);
    }),
);
