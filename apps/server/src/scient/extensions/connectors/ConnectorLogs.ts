// @effect-diagnostics nodeBuiltinImport:off -- Connector logs are small private files in Scient's state folder.
/**
 * The last 16 KB of each local connector's error output, kept on disk across restarts so an
 * agent fixing it can read what went wrong. Callers hand over text with keys already hidden.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

const CONNECTOR_LOG_BYTES = 16 * 1024;
const FOLDER = "connector-logs";

const fileName = (connectorId: string) => `${connectorId.replace(/[^A-Za-z0-9_-]/gu, "_")}.log`;

/** The newest `CONNECTOR_LOG_BYTES` of text, starting at a whole line when one fits. */
const tailOf = (text: string) => {
  if (text.length <= CONNECTOR_LOG_BYTES) return text;
  const cut = text.slice(-CONNECTOR_LOG_BYTES);
  const newline = cut.indexOf("\n");
  return newline === -1 || newline > 1024 ? cut : cut.slice(newline + 1);
};

export const makeConnectorLogs = Effect.fn("ConnectorLogs.make")(function* (stateDir: string) {
  const root = NodePath.join(stateDir, FOLDER);
  /** Tails in memory, loaded from disk once; only those not kept on disk are `ephemeral`. */
  const tails = new Map<string, string>();
  const ephemeral = new Set<string>();
  const writing = new Map<string, Promise<void>>();
  const dirty = new Set<string>();

  const load = (connectorId: string) =>
    tails.has(connectorId)
      ? Promise.resolve()
      : NodeFSP.readFile(NodePath.join(root, fileName(connectorId)), "utf8").then(
          (text) => {
            if (!tails.has(connectorId)) tails.set(connectorId, tailOf(text));
          },
          () => {
            if (!tails.has(connectorId)) tails.set(connectorId, "");
          },
        );

  /** One write at a time per connector; a change while writing is written right after. */
  const flush = (connectorId: string): Promise<void> => {
    const running = writing.get(connectorId);
    if (running !== undefined) {
      dirty.add(connectorId);
      return running;
    }
    const run = (async () => {
      do {
        dirty.delete(connectorId);
        const target = NodePath.join(root, fileName(connectorId));
        const temporary = `${target}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
        await NodeFSP.mkdir(root, { recursive: true });
        await NodeFSP.writeFile(temporary, tails.get(connectorId) ?? "", { mode: 0o600 });
        await NodeFSP.rename(temporary, target).catch(async (error: unknown) => {
          await NodeFSP.rm(temporary, { force: true });
          throw error;
        });
      } while (dirty.has(connectorId) && tails.has(connectorId));
    })()
      .catch(() => undefined)
      .finally(() => writing.delete(connectorId));
    writing.set(connectorId, run);
    return run;
  };

  return {
    /** Adds output; `keep: false` keeps it in memory only (a check of a folder). */
    append: (connectorId: string, text: string, options?: { readonly keep?: boolean }) =>
      Effect.promise(async () => {
        if (options?.keep === false) ephemeral.add(connectorId);
        else await load(connectorId);
        tails.set(connectorId, tailOf((tails.get(connectorId) ?? "") + text));
        if (!ephemeral.has(connectorId)) await flush(connectorId);
      }),
    tail: (connectorId: string) =>
      Effect.promise(async () => {
        if (!ephemeral.has(connectorId)) await load(connectorId);
        return tails.get(connectorId) ?? "";
      }),
    remove: (connectorId: string) =>
      Effect.promise(async () => {
        tails.delete(connectorId);
        ephemeral.delete(connectorId);
        await writing.get(connectorId);
        await NodeFSP.rm(NodePath.join(root, fileName(connectorId)), { force: true });
      }),
  };
});

export type ConnectorLogs = Effect.Success<ReturnType<typeof makeConnectorLogs>>;
