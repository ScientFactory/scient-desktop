// @effect-diagnostics nodeBuiltinImport:off -- Owner-only credential files need no-follow opens and atomic replacement.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { AccountsError, type AccountSummary } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ServerConfig } from "../../../config.ts";

const MAX_AGE = 24 * 60 * 60 * 1000;
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fileError = () =>
  new AccountsError({
    reason: "unavailable",
    message: "Account session files could not be written.",
  });

async function privateDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fileError();
  await NodeFSP.chmod(directory, 0o700);
}

export async function cleanSessionFiles(root: string, now: number) {
  await privateDirectory(root);
  for (const thread of await NodeFSP.readdir(root, { withFileTypes: true })) {
    if (!thread.isDirectory() || !/^[a-f0-9]{64}$/.test(thread.name)) continue;
    const directory = NodePath.join(root, thread.name);
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      const stat = await NodeFSP.lstat(file);
      if (!stat.isDirectory() && stat.mtimeMs < now - MAX_AGE) await NodeFSP.unlink(file);
    }
  }
}

export function credentialContents(
  account: AccountSummary,
  values: Readonly<Record<string, Redacted.Redacted<string>>>,
  directory: string,
) {
  const value = (key: string) => (values[key] === undefined ? "" : Redacted.value(values[key]!));
  const prefix = account.accountId;
  const files: Record<string, string> = {};
  if (account.details.kind === "database") {
    const details = account.details;
    const lineValue = (text: string) => {
      if (/[\r\n\0]/.test(text) || text.trim() !== text) throw fileError();
      return text;
    };
    const service = `${account.name.replace(/[^A-Za-z0-9_-]/g, "_")}_${prefix}`;
    const config = [
      `[${service}]`,
      `host=${lineValue(details.host)}`,
      `port=${details.port}`,
      `dbname=${lineValue(details.database)}`,
      `user=${lineValue(details.user)}`,
      `sslmode=${details.sslmode ?? "verify-full"}`,
    ];
    for (const [field, option] of [
      ["clientCert", "sslcert"],
      ["clientKey", "sslkey"],
      ["caCert", "sslrootcert"],
    ] as const) {
      if (!values[field]) continue;
      const name = `${prefix}-${field}.pem`;
      files[name] = value(field);
      config.push(`${option}=${lineValue(NodePath.join(directory, name))}`);
    }
    if (account.controls.permission === "read-only")
      config.push("options=-c default_transaction_read_only=on");
    files[`${prefix}-pg_service.conf`] = `${config.join("\n")}\n`;
    const pgpass = (text: string) =>
      lineValue(text).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
    files[`${prefix}-.pgpass`] =
      `${[details.host, String(details.port), details.database, details.user, value("password")].map(pgpass).join(":")}\n`;
    return {
      files,
      usage: `PGSERVICEFILE=${shellQuote(NodePath.join(directory, `${prefix}-pg_service.conf`))} PGPASSFILE=${shellQuote(NodePath.join(directory, `${prefix}-.pgpass`))} psql ${shellQuote(`service=${service}`)}`,
    };
  }
  const env: Record<string, string> = {};
  switch (account.details.kind) {
    case "api-key":
      env[account.details.envName ?? "API_KEY"] = value("token");
      break;
    case "cli-login":
      for (const variable of account.details.variables)
        env[variable.name] = variable.secret ? value(variable.name) : (variable.value ?? "");
      break;
    case "website":
    case "library": {
      const name = account.name
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_")
        .replace(/^[0-9]/, "_$&");
      env[`${name}_USERNAME`] = account.details.username ?? "";
      env[`${name}_PASSWORD`] = value("password");
      break;
    }
  }
  if (Object.values(env).some((text) => text.includes("\0"))) throw fileError();
  files[`${prefix}.env`] =
    Object.entries(env)
      .map(([name, text]) => `export ${name}=${shellQuote(text)}`)
      .join("\n") + "\n";
  return { files, usage: `source ${shellQuote(NodePath.join(directory, `${prefix}.env`))}` };
}

export class AccountSessionFiles extends Context.Service<
  AccountSessionFiles,
  {
    readonly directory: (threadId: string) => Effect.Effect<string, AccountsError>;
    readonly write: (
      threadId: string,
      name: string,
      contents: string | Uint8Array,
    ) => Effect.Effect<string, AccountsError>;
  }
>()("t3/scient/accounts/agent/sessionFiles/AccountSessionFiles") {}

export const makeSessionFiles = Effect.fn("AccountSessionFiles.make")(function* (root: string) {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise({ try: () => cleanSessionFiles(root, now), catch: fileError });
  const directory = Effect.fn("AccountSessionFiles.directory")(function* (threadId: string) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: async () => {
        await cleanSessionFiles(root, now);
        const directory = NodePath.join(
          root,
          NodeCrypto.createHash("sha256").update(threadId).digest("hex"),
        );
        await privateDirectory(directory);
        return directory;
      },
      catch: fileError,
    });
  });
  const write = Effect.fn("AccountSessionFiles.write")(function* (
    threadId: string,
    name: string,
    contents: string | Uint8Array,
  ) {
    const target = yield* directory(threadId);
    return yield* Effect.tryPromise({
      try: async () => {
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") throw fileError();
        const file = NodePath.join(target, name);
        const temporary = NodePath.join(target, `.${NodeCrypto.randomUUID()}.tmp`);
        const handle = await NodeFSP.open(
          temporary,
          NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          try {
            await handle.writeFile(contents);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await NodeFSP.rename(temporary, file);
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
        return file;
      },
      catch: fileError,
    });
  });
  return AccountSessionFiles.of({ directory, write });
});

export const AccountSessionFilesLive = Layer.effect(
  AccountSessionFiles,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeSessionFiles(NodePath.join(config.secretsDir, "accounts-sessions"));
  }),
);
