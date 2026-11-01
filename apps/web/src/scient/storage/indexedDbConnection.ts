/**
 * Browsers can close IndexedDB on versionchange or backend failure. Forget and reopen closed cached
 * connections so later transactions do not fail until reload.
 */
export function createIndexedDbConnection(options: {
  readonly name: string;
  readonly version: number;
  readonly upgrade: (database: IDBDatabase) => void;
  readonly blockedMessage: string;
}) {
  let current: Promise<IDBDatabase> | undefined;
  const open = () => {
    let settled = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(options.name, options.version);
      request.addEventListener("upgradeneeded", () => options.upgrade(request.result));
      request.addEventListener("success", () => {
        const database = request.result;
        // A blocked open already reported failure; don't keep its late connection.
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        database.addEventListener("versionchange", () => {
          database.close();
          forget(opening);
        });
        database.addEventListener("close", () => forget(opening));
        resolve(database);
      });
      request.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        reject(request.error);
      });
      request.addEventListener("blocked", () => {
        if (settled) return;
        settled = true;
        reject(new Error(options.blockedMessage));
      });
    });
    return opening;
  };
  // A late event from an earlier connection must not discard a newer one.
  const forget = (connection: Promise<IDBDatabase>) => {
    if (current === connection) current = undefined;
  };
  return {
    /**
     * Runs `use` synchronously with a new transaction. A connection that began
     * closing before its event arrived refuses the transaction; nothing has been
     * written then, so it is reopened and the transaction is retried once.
     */
    async transaction<T>(
      storeNames: string | string[],
      mode: IDBTransactionMode,
      use: (transaction: IDBTransaction) => T | PromiseLike<T>,
    ): Promise<T> {
      for (let attempt = 1; ; attempt++) {
        const connection = (current ??= open());
        // A failed open is never cached; the next call tries again.
        const database = await connection.catch((cause: unknown) => {
          forget(connection);
          throw cause;
        });
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(storeNames, mode);
        } catch (cause) {
          if (attempt > 1 || !(cause instanceof DOMException) || cause.name !== "InvalidStateError")
            throw cause;
          forget(connection);
          continue;
        }
        return use(transaction);
      }
    },
  };
}
