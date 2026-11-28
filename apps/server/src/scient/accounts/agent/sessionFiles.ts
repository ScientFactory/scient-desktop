// @effect-diagnostics nodeBuiltinImport:off -- Owner-only credential files need no-follow opens and atomic replacement.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { AccountsError, type AccountSummary, type AccountsSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../../config.ts";
import { accessChange, Grant, grantsOf, grantStands } from "../accessChanges.ts";
import { AccountsService } from "../AccountsService.ts";

const MAX_AGE = 24 * 60 * 60 * 1000;
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fileError = () =>
  new AccountsError({
    reason: "unavailable",
    message: "Account session files could not be written.",
  });

export async function privateDirectory(directory: string) {
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
      if (stat.mtimeMs >= now - MAX_AGE) continue;
      // An issuance is its own folder, and goes whole.
      if (stat.isDirectory()) await NodeFSP.rm(file, { recursive: true, force: true });
      else await NodeFSP.unlink(file);
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
    case "website": {
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

/** Replaces `directory/name` with an owner-only file, never following a link. */
export async function writePrivateFile(
  directory: string,
  name: string,
  contents: string | Uint8Array,
) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") throw fileError();
  const file = NodePath.join(directory, name);
  const temporary = NodePath.join(directory, `.${NodeCrypto.randomUUID()}.tmp`);
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
}

export class AccountSessionFiles extends Context.Service<
  AccountSessionFiles,
  {
    readonly directory: (threadId: string) => Effect.Effect<string, AccountsError>;
    /** Files that carry no account's access, such as captured network traffic. */
    readonly write: (
      threadId: string,
      name: string,
      contents: string | Uint8Array,
    ) => Effect.Effect<string, AccountsError>;
    /** A new issuance: the folder its files will be in, for contents that name their own paths. */
    readonly begin: (threadId: string) => Effect.Effect<Issuance, AccountsError>;
    /**
     * Publishes an issuance's files with the `grants` they were given under, as one set: refused
     * if a grant changed since, and deleted whole as soon as one changes (`revokeIssuedFiles`).
     */
    readonly issue: (
      issuance: Issuance,
      grants: ReadonlyArray<Grant>,
      files: ReadonlyArray<readonly [name: string, contents: string | Uint8Array]>,
    ) => Effect.Effect<ReadonlyArray<string>, AccountsError>;
  }
>()("t3/scient/accounts/agent/sessionFiles/AccountSessionFiles") {}

const GrantsRecord = Schema.fromJsonString(Schema.Array(Grant));
const encodeGrants = Schema.encodeEffect(GrantsRecord);
const decodeGrants = Schema.decodeUnknownOption(GrantsRecord);
export interface Issuance {
  readonly thread: string;
  readonly id: string;
  readonly directory: string;
}
/** Inside each issuance, the grants its files were given under. */
const GRANTS = ".grants";
const ISSUANCE = /^[a-f0-9-]{36}$/;
const changedAccess = () =>
  new AccountsError({
    reason: "denied",
    message: "Access to this account changed. Ask again.",
  });
const stands = (snapshot: AccountsSnapshot, grants: ReadonlyArray<Grant>) => {
  const current = grantsOf(snapshot);
  return snapshot.agentAccess && grants.every((grant) => grantStands(current, grant));
};

export const makeSessionFiles = Effect.fn("AccountSessionFiles.make")(function* (
  root: string,
  /** Accounts as they stand now; without it nothing can be issued. */
  current: Effect.Effect<AccountsSnapshot, AccountsError> = Effect.fail(changedAccess()),
) {
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
      try: () => writePrivateFile(target, name, contents),
      catch: fileError,
    });
  });
  const begin = Effect.fn("AccountSessionFiles.begin")(function* (threadId: string) {
    const thread = yield* directory(threadId);
    const id = NodeCrypto.randomUUID();
    return { thread, id, directory: NodePath.join(thread, id) };
  });
  // Written whole under a temporary name and renamed into place, under the folder's lock; the
  // access is checked again after, and whichever of this and a revocation runs second deletes it.
  const issue = Effect.fn("AccountSessionFiles.issue")(function* (
    issuance: Issuance,
    grants: ReadonlyArray<Grant>,
    files: ReadonlyArray<readonly [name: string, contents: string | Uint8Array]>,
  ) {
    if (!stands(yield* current, grants)) return yield* changedAccess();
    const record = yield* encodeGrants(grants).pipe(Effect.mapError(fileError));
    const paths = yield* Effect.tryPromise({
      try: () =>
        withFolderLock(issuance.thread, async () => {
          const staging = NodePath.join(issuance.thread, `.${issuance.id}.tmp`);
          await privateDirectory(staging);
          try {
            await writePrivateFile(staging, GRANTS, record);
            for (const [name, contents] of files) await writePrivateFile(staging, name, contents);
            await NodeFSP.rename(staging, issuance.directory);
          } finally {
            await NodeFSP.rm(staging, { recursive: true, force: true });
          }
          return files.map(([name]) => NodePath.join(issuance.directory, name));
        }),
      catch: fileError,
    });
    if (stands(yield* current, grants)) return paths;
    yield* Effect.tryPromise({
      try: () =>
        withFolderLock(issuance.thread, () =>
          NodeFSP.rm(issuance.directory, { recursive: true, force: true }),
        ),
      catch: fileError,
    }).pipe(Effect.ignore);
    return yield* changedAccess();
  });
  return AccountSessionFiles.of({ directory, write, begin, issue });
});

const sessionsRoot = (config: ServerConfig["Service"]) =>
  NodePath.join(config.secretsDir, "accounts-sessions");

// Issuing and revoking can run in different service instances over the same folder, so the lock
// is the folder's, for the whole process: each pair is published and swept whole.
const folderLocks = new Map<string, Promise<unknown>>();
async function withFolderLock<A>(directory: string, run: () => Promise<A>): Promise<A> {
  const turn = (folderLocks.get(directory) ?? Promise.resolve()).catch(() => {}).then(run);
  const settled = turn.catch(() => {});
  folderLocks.set(directory, settled);
  try {
    return await turn;
  } finally {
    if (folderLocks.get(directory) === settled) folderLocks.delete(directory);
  }
}

/** An account output of an earlier layout, kept loose in the thread's folder. */
const unrecordedOutput = (name: string) =>
  !name.startsWith(".") && (name.startsWith("acc_") || /-cookies\.(?:txt|json)$/.test(name));

const readGrants = (file: string) =>
  NodeFSP.readFile(file, "utf8")
    .then((text) => Option.getOrUndefined(decodeGrants(text)))
    .catch(() => undefined);

/**
 * Deletes every issuance whose grants no longer stand or name something `gone`, whole; leftovers of
 * one cut short; and account outputs of an earlier layout. A failed deletion is tried next time.
 */
async function reconcileIssued(
  root: string,
  snapshot: AccountsSnapshot,
  gone: ReadonlySet<string>,
) {
  const threads = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const thread of threads) {
    if (!thread.isDirectory() || !/^[a-f0-9]{64}$/.test(thread.name)) continue;
    const directory = NodePath.join(root, thread.name);
    await withFolderLock(directory, async () => {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = NodePath.join(directory, entry.name);
        const remove = () => NodeFSP.rm(path, { recursive: true, force: true }).catch(() => {});
        if (entry.isDirectory()) {
          // No writer holds the lock now, so a staging folder is one that was cut short.
          if (/^\..+\.tmp$/.test(entry.name)) await remove();
          else if (ISSUANCE.test(entry.name)) {
            const grants = await readGrants(NodePath.join(path, GRANTS));
            if (!grants || !stands(snapshot, grants) || grants.some(({ key }) => gone.has(key)))
              await remove();
          }
          continue;
        }
        if (unrecordedOutput(entry.name) || /^\..+\.grants$/.test(entry.name)) await remove();
      }
    });
  }
}

/**
 * Off, Remove or narrower access reaches what agents were already given: files issued under a
 * grant that changed are deleted from every conversation's folder, and every one when agent
 * access is turned off. Also on start, so a deletion that failed or was cut short finishes.
 */
export const revokeIssuedFiles = Effect.fn("AccountSessionFiles.revokeIssued")(function* (
  root: string,
  changes: Stream.Stream<AccountsSnapshot>,
) {
  let previous: AccountsSnapshot | undefined;
  yield* Stream.runForEach(changes, (next) => {
    const before = previous;
    previous = next;
    if (before && !accessChange(before, next)) return Effect.void;
    // A removed profile's record is gone; its grants would otherwise read as the defaults.
    const now = grantsOf(next);
    const gone = new Set(before ? [...grantsOf(before).keys()].filter((key) => !now.has(key)) : []);
    return Effect.tryPromise({
      try: () => reconcileIssued(root, next, gone),
      catch: fileError,
    }).pipe(Effect.ignore);
  });
});

/** Server-lifetime: follows Accounts so access taken away reaches files already issued. */
export const IssuedFilesRevocationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const root = sessionsRoot(yield* ServerConfig);
    yield* revokeIssuedFiles(root, accounts.changes).pipe(Effect.forkScoped);
  }),
);

export const AccountSessionFilesLive = Layer.effect(
  AccountSessionFiles,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeSessionFiles(sessionsRoot(config), (yield* AccountsService).snapshot);
  }),
);
