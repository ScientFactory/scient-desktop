import "fake-indexeddb/auto";

import { expect, it } from "vite-plus/test";

import { createIndexedDbPdfOcrCache } from "./pdfOcrCache";

it("evicts the oldest reading and alias even on the first write after reopening", async () => {
  const recognizer = "test";
  const text = { recognizer, rotation: 0, lines: [] };
  const cache = createIndexedDbPdfOcrCache(recognizer);
  await cache.put("first", "page-0", text);

  // Preload the rest of a full profile in one transaction.
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("scient-pdf-ocr");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const transaction = database.transaction(["pages", "aliases"], "readwrite");
    transaction.objectStore("pages").put({ text, usedAt: 0 }, recognizer + "\nfirst");
    transaction.objectStore("aliases").put({ image: "first", usedAt: 0 }, recognizer + "\npage-0");
    for (let page = 1; page < 4000; page++) {
      const usedAt = page;
      const image = String(page);
      transaction.objectStore("pages").put({ text, usedAt }, recognizer + "\n" + image);
      transaction.objectStore("aliases").put({ image, usedAt }, recognizer + "\npage-" + page);
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    const reopened = createIndexedDbPdfOcrCache(recognizer);
    await reopened.put("latest", "page-4000", text);
    expect(await reopened.byImage("first")).toBeNull();
    expect(await reopened.byPage("page-4000")).toEqual(text);
    const aliases = database.transaction("aliases").objectStore("aliases");
    const count = await new Promise<number>((resolve, reject) => {
      const result = aliases.count();
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    });
    expect(count).toBe(4000);
  } finally {
    database.close();
  }
});
