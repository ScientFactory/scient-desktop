import "fake-indexeddb/auto";
import { forceCloseDatabase as forceCloseFakeDatabase } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createIndexedDbConnection } from "./indexedDbConnection";

// fake-indexeddb types this parameter as the IDBDatabase class, not a connection.
const forceCloseDatabase = (database: IDBDatabase) =>
  forceCloseFakeDatabase(database as unknown as typeof IDBDatabase);

let count = 0;
function setup() {
  const name = `indexed-db-connection-${++count}`;
  const open = vi.spyOn(indexedDB, "open");
  const connection = createIndexedDbConnection({
    name,
    version: 1,
    upgrade: (database) => database.createObjectStore("values"),
    blockedMessage: "Storage is blocked.",
  });
  const request = <T>(value: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      value.addEventListener("success", () => resolve(value.result));
      value.addEventListener("error", () => reject(value.error));
    });
  return {
    name,
    open,
    database: () => connection.transaction("values", "readonly", (transaction) => transaction.db),
    put: (key: string, value: string) =>
      connection.transaction("values", "readwrite", (transaction) =>
        request(transaction.objectStore("values").put(value, key)),
      ),
    get: (key: string) =>
      connection.transaction("values", "readonly", (transaction) =>
        request<unknown>(transaction.objectStore("values").get(key)),
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createIndexedDbConnection", () => {
  it("reuses one connection while it stays open", async () => {
    const storage = setup();
    await storage.put("a", "1");
    await expect(storage.get("a")).resolves.toBe("1");
    expect(storage.open).toHaveBeenCalledTimes(1);
  });

  it("reopens after the browser force-closes the connection", async () => {
    const storage = setup();
    await storage.put("a", "1");
    const first = await storage.database();
    forceCloseDatabase(first);

    await storage.put("b", "2");
    await expect(storage.get("a")).resolves.toBe("1");
    expect(await storage.database()).not.toBe(first);
    expect(storage.open).toHaveBeenCalledTimes(2);
  });

  it("retries once when the connection is closing before its close event arrives", async () => {
    const storage = setup();
    await storage.put("a", "1");
    (await storage.database()).close();

    await storage.put("b", "2");
    await expect(storage.get("b")).resolves.toBe("2");
    expect(storage.open).toHaveBeenCalledTimes(2);
  });

  it("does not retry other transaction failures", async () => {
    const storage = setup();
    const connection = createIndexedDbConnection({
      name: storage.name,
      version: 1,
      upgrade: (database) => database.createObjectStore("values"),
      blockedMessage: "Storage is blocked.",
    });
    await expect(connection.transaction("missing", "readonly", () => undefined)).rejects.toThrow(
      expect.objectContaining({ name: "NotFoundError" }),
    );
    expect(storage.open).toHaveBeenCalledTimes(1);
  });

  it("closes for another window's upgrade or deletion and reopens afterwards", async () => {
    const storage = setup();
    await storage.put("a", "1");
    const first = await storage.database();
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(storage.name);
      deletion.addEventListener("success", () => resolve());
      deletion.addEventListener("error", () => reject(deletion.error));
      deletion.addEventListener("blocked", () => reject(new Error("deletion was blocked")));
    });

    await expect(storage.get("a")).resolves.toBeUndefined();
    await storage.put("a", "2");
    await expect(storage.get("a")).resolves.toBe("2");
    expect(await storage.database()).not.toBe(first);
  });

  it("keeps a newer connection when an older one reports its close late", async () => {
    const storage = setup();
    const first = await storage.database();
    first.close();
    const second = await storage.database();
    expect(second).not.toBe(first);

    forceCloseDatabase(first);
    expect(await storage.database()).toBe(second);
    expect(storage.open).toHaveBeenCalledTimes(2);
  });

  it("opens again after a failed open instead of keeping the failure", async () => {
    const storage = setup();
    const newer = indexedDB.open(storage.name, 2);
    await new Promise<void>((resolve) => newer.addEventListener("success", () => resolve()));
    newer.result.close();
    const opensBefore = storage.open.mock.calls.length;

    // The stored database is newer than this window's code, so opening fails.
    await expect(storage.get("a")).rejects.toThrow(
      expect.objectContaining({ name: "VersionError" }),
    );
    await expect(storage.get("a")).rejects.toThrow(
      expect.objectContaining({ name: "VersionError" }),
    );
    expect(storage.open.mock.calls.length).toBe(opensBefore + 2);
  });

  it("opens again after indexedDB.open throws", async () => {
    const storage = setup();
    storage.open.mockImplementationOnce(() => {
      throw new DOMException("Storage is unavailable.", "SecurityError");
    });

    await expect(storage.get("a")).rejects.toThrow("Storage is unavailable.");
    await storage.put("a", "1");
    await expect(storage.get("a")).resolves.toBe("1");
  });

  it("rejects a blocked upgrade and closes the connection that opens later", async () => {
    const storage = setup();
    // An older window that ignores versionchange keeps the upgrade blocked.
    const holder = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(storage.name, 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore("values"));
      request.addEventListener("success", () => resolve(request.result));
    });
    const upgrading = createIndexedDbConnection({
      name: storage.name,
      version: 2,
      upgrade: () => undefined,
      blockedMessage: "Storage is blocked.",
    });
    await expect(upgrading.transaction("values", "readonly", () => undefined)).rejects.toThrow(
      "Storage is blocked.",
    );

    holder.close();
    // A deletion queued behind the late open is blocked only if its connection leaked.
    await expect(
      new Promise<void>((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase(storage.name);
        deletion.addEventListener("success", () => resolve());
        deletion.addEventListener("blocked", () => reject(new Error("a connection leaked")));
      }),
    ).resolves.toBeUndefined();
  });
});
