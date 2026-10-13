/**
 * One cached IndexedDB connection that is replaced once the browser closes it.
 *
 * The browser may close a connection at any time: another window upgrading or
 * deleting the database (`versionchange`), or Chromium force-closing storage
 * after a backend failure (`close`). A cached connection that outlives that
 * makes every later transaction fail with "The database connection is closing"
 * until the window reloads, so it is forgotten and reopened instead.
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
        forget(opening);
        reject(request.error);
      });
      request.addEventListener("blocked", () => {
        if (settled) return;
        settled = true;
        forget(opening);
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
        const database = await connection;
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
