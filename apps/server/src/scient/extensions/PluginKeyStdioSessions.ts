// @effect-diagnostics nodeBuiltinImport:off -- Private launcher files use the Accounts no-follow writer and exact-path cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Redacted from "effect/Redacted";
import {
  isReservedConnectorServerName,
  type ProviderInstanceId,
  type ProjectId,
} from "@t3tools/contracts";
import type { McpPluginKeyPolicy } from "@t3tools/provider-core/server/mcpSession";
import { makeSessionFiles } from "../accounts/agent/sessionFiles.ts";
import { readLocalPluginKeyStdioServers } from "./LocalPluginContents.ts";
import type { PluginKeyBindings } from "./PluginKeyBindings.ts";
import type { ProviderRegistryShape } from "../../provider/ProviderRegistry.ts";

/** Standalone module avoids source-tree paths and dependency lookup. */
const pluginKeyLauncherSource = `
import { open, unlink, constants } from 'node:fs/promises';
import { isAbsolute, join, delimiter } from 'node:path';
try {
  if (process.argv.length !== 3 || typeof process.execve !== 'function') throw 0;
  const file = process.argv[2];
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 1048576) throw 0;
    const bytes = Buffer.alloc(1048577);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1048576 || bytesRead !== stat.size) throw 0;
    value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
  // Consume before exec: even an exec failure cannot leave a reusable secret file.
  await unlink(file);
  if (!value || typeof value.command !== 'string' || !Array.isArray(value.args) ||
      value.args.some(arg => typeof arg !== 'string' || arg.includes('\\0')) ||
      !value.env || typeof value.env !== 'object' || Array.isArray(value.env)) throw 0;
  const env = Object.assign(Object.create(null), process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [name, text] of Object.entries(value.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof text !== 'string' || text.includes('\\0')) throw 0;
    env[name] = text;
  }
  let command = value.command;
  if (!isAbsolute(command) && !command.includes('/')) {
    const { access } = await import('node:fs/promises');
    let found;
    for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
      const candidate = join(directory, command);
      try { await access(candidate, constants.X_OK); found = candidate; break; } catch {}
    }
    if (!found) throw 0;
    command = found;
  }
  const { closeSync, openSync } = await import('node:fs');
  closeSync(2);
  if (openSync('/dev/null', 'w') !== 2) throw 0;
  process.execve(command, [value.command, ...value.args], env);
} catch {
  // Do not print errors, file contents, commands or arguments.
  process.stderr.write('Scient plugin server could not start.\\n');
  process.exitCode = 1;
}
`;

const encode = (value: unknown) => JSON.stringify(value);

export const preparePluginKeyStdio = Effect.fn("PluginKeyStdio.prepare")(function* (
  providers: ProviderRegistryShape,
  bindings: PluginKeyBindings["Service"],
  input: {
    agent: ProviderInstanceId;
    projectId: ProjectId | undefined;
    policies: ReadonlyArray<McpPluginKeyPolicy>;
  },
) {
  const platform = yield* HostProcess.Platform;
  const standalone = yield* HostProcess.IsExecutable;
  const provider = (yield* providers.getProviders).find((p) => p.instanceId === input.agent);
  const prepared: Array<{ serverName: string; contents: Redacted.Redacted<string> }> = [];
  if (
    platform === "win32" ||
    standalone ||
    typeof process.execve !== "function" ||
    !provider ||
    (provider.driver !== "claudeAgent" && provider.driver !== "codex")
  )
    return prepared;
  for (const policy of input.policies) {
    if (!policy.path) continue;
    const target = {
      agent: input.agent,
      pluginId: policy.bindingPluginId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    const state = yield* bindings.list(target, policy.requiredKeys);
    if (state.status !== "ready") continue;
    const servers = yield* Effect.tryPromise(() => readLocalPluginKeyStdioServers(policy.path!));
    for (const server of servers) {
      const serverName =
        provider.driver === "claudeAgent"
          ? `plugin:${policy.pluginName}:${server.name}`
          : server.name;
      if (
        provider.driver === "codex" &&
        (isReservedConnectorServerName(serverName) ||
          input.policies.filter((p) => p.serverNames.includes(server.name)).length !== 1 ||
          provider.mcpServers?.some(
            (native) => native.name === serverName && native.pluginId !== policy.bindingPluginId,
          ))
      )
        continue;
      const values = yield* Effect.forEach(server.envNames, (envName) =>
        bindings
          .resolveKey({
            ...target,
            envName,
            expectedRef: state.keys.find((key) => key.envName === envName)?.accountRef,
          })
          .pipe(Effect.map((value) => [envName, Redacted.value(value)] as const)),
      ).pipe(
        Effect.map((entries) => Object.fromEntries(entries)),
        Effect.orElseSucceed(() => undefined),
      );
      if (!values) continue;
      const env = {
        ...values,
        ...Object.fromEntries(
          Object.entries(server.env).map(([name, template]) => [
            name,
            values[name] !== undefined && /^(?:\s*|<[^<>]+>|YOUR_[A-Z0-9_]+)$/i.test(template)
              ? values[name]!
              : template.replace(
                  /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g,
                  (_, key: string) => values[key]!,
                ),
          ]),
        ),
      };
      prepared.push({
        serverName,
        contents: Redacted.make(encode({ command: server.command, args: server.args, env })),
      });
    }
  }
  return prepared;
});

export const makePluginKeyStdioSessions = Effect.fn("PluginKeyStdio.make")(function* (
  secretsDir: string,
) {
  const executable = yield* HostProcess.ExecutablePath;
  const writer = yield* makeSessionFiles(NodePath.join(secretsDir, "accounts-sessions"));
  const owned = new Map<string, Set<string>>();
  const clear = Effect.fn("PluginKeyStdio.clear")(function* (credentialId: string) {
    const paths = owned.get(credentialId);
    if (!paths) return;
    yield* Effect.tryPromise(async () => {
      for (const file of paths) await NodeFSP.rm(file, { force: true });
      owned.delete(credentialId);
    });
  });
  const write = Effect.fn("PluginKeyStdio.write")(function* (
    threadId: string,
    credentialId: string,
    prepared: ReadonlyArray<{ serverName: string; contents: Redacted.Redacted<string> }>,
  ) {
    if (!prepared.length) return [];
    const files = new Set<string>();
    owned.set(credentialId, files);
    return yield* Effect.forEach(
      prepared,
      Effect.fn("PluginKeyStdio.writeServer")(function* (server) {
        const name = `plugin-${NodeCrypto.randomUUID()}`;
        const launcher = yield* writer.write(threadId, `${name}.mjs`, pluginKeyLauncherSource);
        files.add(launcher);
        const file = yield* writer.write(threadId, `${name}.json`, Redacted.value(server.contents));
        files.add(file);
        return {
          serverName: server.serverName,
          command: executable,
          args: [launcher, file],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
      }),
    ).pipe(Effect.onError(() => clear(credentialId).pipe(Effect.orDie)));
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...owned.keys()], (id) => clear(id).pipe(Effect.orDie), { discard: true }),
  );
  return { write, clear };
});
