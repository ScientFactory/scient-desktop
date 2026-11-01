// @effect-diagnostics nodeBuiltinImport:off -- Bounded shell-free processes call user-installed CLIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  AccountsError,
  type CliPasswordStore,
  type CliPasswordStatus,
  type CliPasswordSource,
  type CliPasswordItem,
  type CliPasswordStoreInput,
} from "@t3tools/contracts";
import { Effect, Redacted, Schema } from "effect";
const text = Schema.optional(Schema.NullOr(Schema.String));
const BwStatus = Schema.Struct({
  status: Schema.Literals(["unauthenticated", "locked", "unlocked"]),
  serverUrl: Schema.NullOr(Schema.String),
  userEmail: text,
  userId: text,
});
const BwItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  deletedDate: text,
  login: Schema.optional(
    Schema.NullOr(Schema.Struct({ username: text, password: text, totp: text })),
  ),
  fields: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: text, value: text })))),
});
const PassInfo = Schema.Struct({
  id: Schema.String,
  email: Schema.optional(Schema.String),
  personal_access_token_name: Schema.optional(Schema.String),
});
const PassItems = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ id: Schema.String, share_id: Schema.String, title: Schema.String }),
  ),
});
const PassVaults = Schema.Struct({
  vaults: Schema.Array(Schema.Struct({ share_id: Schema.String })),
});
const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  output: string,
): S["Type"] => Schema.decodeSync(Schema.fromJsonString(schema))(output);
const fail = () =>
  new AccountsError({
    reason: "unavailable",
    message: "Password store is unavailable or locked. Check its CLI connection in Accounts.",
  });
export interface PasswordStoreAdapter {
  status(signal?: AbortSignal): Promise<CliPasswordStatus>;
  connect(password?: Redacted.Redacted<string>, signal?: AbortSignal): Promise<CliPasswordStatus>;
  disconnect(): void;
  list(query: string, signal?: AbortSignal): Promise<ReadonlyArray<CliPasswordItem>>;
  resolve(source: CliPasswordSource, signal?: AbortSignal): Promise<Redacted.Redacted<string>>;
}
export function makeCliPasswordStores(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  timeout?: number;
  maxBuffer?: number;
  commonDirectories?: ReadonlyArray<string>;
}) {
  const hostEnv = options.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "BITWARDENCLI_APPDATA_DIR",
  ])
    if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
  const statuses: Record<CliPasswordStore, CliPasswordStatus> = {
    bitwarden: { state: "not-connected" },
    "proton-pass": { state: "not-connected" },
  };
  const adapters = new Map<CliPasswordStore, PasswordStoreAdapter>();
  for (const store of ["bitwarden", "proton-pass"] as const) {
    let generation = 0;
    let binary: string | undefined;
    let connection: string | undefined;
    let session: Redacted.Redacted<string> | undefined;
    const discover = async () => {
      if (binary) return binary;
      const name =
        (store === "bitwarden" ? "bw" : "pass-cli") + (options.platform === "win32" ? ".exe" : "");
      for (const dir of [
        ...(env.PATH ?? "").split(NodePath.delimiter).filter(Boolean),
        ...(options.commonDirectories ?? [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          NodePath.join(env.HOME ?? NodeOS.homedir(), ".local", "bin"),
          NodePath.join(env.HOME ?? NodeOS.homedir(), ".npm-global", "bin"),
        ]),
      ]) {
        const path = NodePath.join(dir, name);
        try {
          await NodeFSP.access(path, NodeFS.constants.X_OK);
          binary = path;
          return path;
        } catch {
          /* Try the next installation location. */
        }
      }
      return undefined;
    };
    const run = async (
      argv: string[],
      password?: Redacted.Redacted<string>,
      signal?: AbortSignal,
    ) => {
      const path = await discover();
      if (!path) throw fail();
      return await new Promise<string>((resolve, reject) => {
        const child = NodeChildProcess.execFile(
          path,
          argv,
          {
            shell: false,
            ...(signal ? { signal } : {}),
            env: {
              ...env,
              BW_NOINTERACTION: "true",
              ...(session ? { BW_SESSION: Redacted.value(session) } : {}),
              ...(password ? { SCIENT_BW_PASSWORD: Redacted.value(password) } : {}),
            },
            timeout: options.timeout ?? 15_000,
            maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
            killSignal: "SIGKILL",
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(fail()) : resolve(stdout)),
        );
        child.stdin?.end();
      });
    };
    const readStatus = async (signal?: AbortSignal): Promise<CliPasswordStatus> => {
      if (!(await discover())) return { state: "not-installed" };
      if (store === "bitwarden") {
        const value = decode(BwStatus, await run(["status"], undefined, signal));
        return {
          state: value.status,
          serverUrl: value.serverUrl ?? "https://vault.bitwarden.com",
          ...(value.userEmail ? { email: value.userEmail } : {}),
          ...(value.userId
            ? {
                connection: JSON.stringify([
                  value.serverUrl ?? "https://vault.bitwarden.com",
                  value.userId,
                ]),
              }
            : {}),
        };
      }
      const info = decode(PassInfo, await run(["info", "--output", "json"], undefined, signal));
      return {
        state: "unlocked",
        connection: JSON.stringify([
          info.id,
          info.email ?? "",
          info.personal_access_token_name ?? "",
        ]),
        ...(info.email ? { email: info.email } : {}),
      };
    };
    const status = async (signal?: AbortSignal) => {
      try {
        statuses[store] = await readStatus(signal);
      } catch {
        statuses[store] = { state: "unavailable" };
      }
      return statuses[store];
    };
    const requireConnection = async (source?: CliPasswordSource, signal?: AbortSignal) => {
      const current = await status(signal);
      if (
        !connection ||
        current.state !== "unlocked" ||
        current.connection !== connection ||
        (source && source.connection !== connection)
      )
        throw fail();
    };
    const adapter: PasswordStoreAdapter = {
      status,
      async connect(password, signal) {
        const version = ++generation;
        connection = undefined;
        session = undefined;
        if (store === "bitwarden") {
          if (password)
            session = Redacted.make(
              (
                await run(
                  ["unlock", "--passwordenv", "SCIENT_BW_PASSWORD", "--raw"],
                  password,
                  signal,
                )
              ).trim(),
            );
        }
        const current = await status(signal);
        if (signal?.aborted || version !== generation) {
          session = undefined;
          throw fail();
        }
        if (current.state === "unlocked" && current.connection) connection = current.connection;
        else session = undefined;
        return current;
      },
      disconnect() {
        generation++;
        session = undefined;
        connection = undefined;
        statuses[store] = { state: "not-connected" };
      },
      async list(query, signal) {
        await requireConnection(undefined, signal);
        if (store === "bitwarden") {
          const items = decode(
            Schema.Array(BwItem),
            await run(["list", "items", "--search", query], undefined, signal),
          );
          return items
            .filter((item) => !item.deletedDate)
            .slice(0, 100)
            .map((item) => ({
              itemId: item.id,
              name: item.name,
              fields: [
                ...(item.login?.username != null ? ["username"] : []),
                ...(item.login?.password != null ? ["password"] : []),
                ...(item.login?.totp ? ["totp"] : []),
                ...(item.fields ?? []).flatMap((field) =>
                  field.name ? [`custom:${field.name}`] : [],
                ),
              ],
            }));
        }
        const vaults = decode(
          PassVaults,
          await run(["vault", "list", "--output", "json"], undefined, signal),
        );
        const items: CliPasswordItem[] = [];
        for (const vault of vaults.vaults.slice(0, 50)) {
          const result = decode(
            PassItems,
            await run(
              ["item", "list", "--share-id", vault.share_id, "--output", "json"],
              undefined,
              signal,
            ),
          );
          for (const item of result.items)
            if (item.title.toLowerCase().includes(query.toLowerCase()) && items.length < 100)
              items.push({
                itemId: item.id,
                vaultId: item.share_id,
                name: item.title,
                fields: ["username", "password", "email", "totp"],
              });
        }
        return items;
      },
      async resolve(source, signal) {
        await requireConnection(source, signal);
        if (store === "proton-pass") {
          if (!source.vaultId) throw fail();
          return Redacted.make(
            (
              await run([
                "item",
                "view",
                `pass://${source.vaultId}/${source.itemId}/${source.field}`,
                "--output",
                "json",
              ])
            ).replace(/\r?\n$/, ""),
          );
        }
        if (source.field === "totp")
          return Redacted.make(
            (await run(["get", "totp", source.itemId], undefined, signal)).trim(),
          );
        const item = decode(BwItem, await run(["get", "item", source.itemId], undefined, signal));
        if (item.id !== source.itemId || item.deletedDate) throw fail();
        const matches = source.field.startsWith("custom:")
          ? (item.fields ?? []).filter((field) => field.name === source.field.slice(7))
          : [];
        const value =
          source.field === "username"
            ? item.login?.username
            : source.field === "password"
              ? item.login?.password
              : matches.length === 1
                ? matches[0]?.value
                : undefined;
        if (value == null) throw fail();
        return Redacted.make(value);
      },
    };
    adapters.set(store, adapter);
  }
  return {
    statuses: () => ({ ...statuses }),
    dispose: () => {
      for (const adapter of adapters.values()) adapter.disconnect();
    },
    command: Effect.fn("CliPasswordStores.command")((input: CliPasswordStoreInput) =>
      Effect.tryPromise({
        try: async (signal) => {
          const adapter = adapters.get(input.store)!;
          if (input.action === "disconnect") {
            adapter.disconnect();
            return { status: statuses[input.store], items: [] };
          }
          const status =
            input.action === "connect"
              ? await adapter.connect(
                  input.password ? Redacted.make(input.password) : undefined,
                  signal,
                )
              : await adapter.status(signal);
          return {
            status,
            items: input.action === "list" ? await adapter.list(input.query ?? "", signal) : [],
          };
        },
        catch: fail,
      }),
    ),
    resolve: Effect.fn("CliPasswordStores.resolve")((source: CliPasswordSource) =>
      Effect.tryPromise({
        try: (signal) => adapters.get(source.type)!.resolve(source, signal),
        catch: fail,
      }),
    ),
  };
}
