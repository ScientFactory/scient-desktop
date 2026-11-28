// @effect-diagnostics nodeBuiltinImport:off -- Starts the short-lived Messages and Mail reader.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { CodeCandidate } from "./messageCodes.ts";

/** What one look needs: the service's words, and the account's sites and username for Mail. */
export interface CodeLook {
  readonly sinceMs: number;
  readonly service: ReadonlyArray<string>;
  /** Named only by a domain other services share: by the sender, never typed. */
  readonly shared?: boolean | undefined;
  readonly sites: ReadonlyArray<string>;
  readonly username?: string | undefined;
}

export interface CodeReaders {
  readonly messagesReadable: () => boolean;
  readonly mailReadable: () => boolean;
  readonly readMessageCodes: (
    sinceMs: number,
    service: ReadonlyArray<string>,
    database?: string,
    shared?: boolean,
  ) => ReadonlyArray<CodeCandidate>;
  readonly readMailCodes: (
    sinceMs: number,
    service: ReadonlyArray<string>,
    account: { readonly sites: ReadonlyArray<string>; readonly username?: string | undefined },
    database?: string,
    shared?: boolean,
  ) => ReadonlyArray<CodeCandidate>;
}

const quietly = <A>(read: () => ReadonlyArray<A>) => {
  try {
    return read();
  } catch {
    return [];
  }
};

/**
 * The reader process's whole work: `readable`, or `codes` with a `CodeLook`. Each candidate keeps
 * only what choosing and typing a code needs; a message's text never leaves this process.
 */
export function runSignInCodesWorker(args: ReadonlyArray<string>, readers: CodeReaders) {
  if (args[0] === "readable")
    return { messages: readers.messagesReadable(), mail: readers.mailReadable() };
  if (args[0] !== "codes" || args[1] === undefined) return [];
  const look = JSON.parse(args[1]) as CodeLook;
  const account = { sites: look.sites, username: look.username };
  return [
    ...quietly(() =>
      readers.readMessageCodes(look.sinceMs, look.service, undefined, look.shared === true),
    ),
    ...quietly(() =>
      readers.readMailCodes(look.sinceMs, look.service, account, undefined, look.shared === true),
    ),
    // Whether it names the service travels with it: the engine decides by it.
  ].map(({ key, code, source, at, sender, toAccount, named }) => ({
    key,
    code,
    source,
    at,
    sender,
    ...(toAccount === undefined ? {} : { toAccount }),
    ...(named === undefined ? {} : { named }),
  }));
}

/** Runs the reader with these arguments and returns its JSON, or nothing when it can't run. */
export type CodeReaderRun = (args: ReadonlyArray<string>) => Promise<unknown>;

/** The built reader beside the server's bundle, or the source entry in a source run. */
const workerPath = () => {
  const here = new URL(import.meta.url);
  const built = here.pathname.endsWith(".mjs");
  const path = NodeURL.fileURLToPath(
    new URL(built ? "./sign-in-codes-worker.mjs" : "../../../sign-in-codes-worker.ts", here),
  );
  return NodeFS.existsSync(path) ? path : undefined;
};

/** A new process for each run, so macOS asks again about Full Disk Access. */
export const runCodeReader: CodeReaderRun = (args) =>
  new Promise((resolve) => {
    const path = workerPath();
    // A single executable has no reader beside it: nothing reads.
    if (path === undefined) return resolve(undefined);
    NodeChildProcess.execFile(
      process.execPath,
      [path, ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(undefined);
        }
      },
    );
  });

const isCandidate = (value: unknown): value is CodeCandidate => {
  const row = value as Partial<CodeCandidate> | null;
  return (
    typeof row?.key === "string" &&
    typeof row.code === "string" &&
    /^\d{4,8}$/u.test(row.code) &&
    (row.source === "messages" || row.source === "mail") &&
    typeof row.at === "number" &&
    typeof row.sender === "string"
  );
};

/** The last answer and when it came, which snapshots reuse for a moment. */
let lastCheck: { readonly readable: boolean; readonly at: number } | undefined;
export const lastCodeSourcesCheck = () => lastCheck;

/** Whether a fresh process can read Messages or Mail on this Mac; snapshots reuse the answer. */
export const codeSourcesReadable = Effect.fn("Accounts.codeSourcesReadable")(function* (
  run: CodeReaderRun = runCodeReader,
) {
  const answer = yield* Effect.promise(() => run(["readable"]));
  const read = answer as { readonly messages?: unknown; readonly mail?: unknown } | undefined;
  const readable = read?.messages === true || read?.mail === true;
  lastCheck = { readable, at: yield* Clock.currentTimeMillis };
  return readable;
});

/** The codes a fresh process finds for one look; none when it can't read or run. */
export const readCodesFresh = (look: CodeLook, run: CodeReaderRun = runCodeReader) =>
  Effect.promise(() => run(["codes", encodeLook(look)])).pipe(
    Effect.map((answer) => (Array.isArray(answer) ? answer.filter(isCandidate) : [])),
  );

function encodeLook(look: CodeLook) {
  return JSON.stringify(look);
}
