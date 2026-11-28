import "fake-indexeddb/auto";

import { expect, it } from "vite-plus/test";

import { createIndexedDbPdfOcrCache, createMemoryPdfOcrCache } from "./pdfOcrCache";

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

it("keeps a password-unlocked document's readings bounded, dropping the least recently used", async () => {
  // The rotation only tells the readings apart.
  const text = (rotation: number) => ({ recognizer: "test", rotation, lines: [] });
  const cache = createMemoryPdfOcrCache(2);
  await cache.put("a", "page-1", text(1));
  await cache.put("b", "page-2", text(2));
  // Reading page 1 again makes page 2 the oldest.
  expect(await cache.byPage("page-1")).toEqual(text(1));
  await cache.put("c", "page-3", text(3));
  expect(await cache.byImage("b")).toBeNull();
  expect(await cache.byPage("page-2")).toBeNull();
  expect(await cache.byPage("page-1")).toEqual(text(1));
  expect(await cache.byPage("page-3")).toEqual(text(3));
});

it("keeps a hot alias when memory cache evicts the oldest alias", async () => {
  const text = (rotation: number) => ({ recognizer: "test", rotation, lines: [] });
  const cache = createMemoryPdfOcrCache(2);
  // Two aliases share one image, then a third alias exceeds maxPages aliases.
  await cache.put("shared", "page-1", text(1));
  await cache.put("shared", "page-2", text(1));
  expect(await cache.byPage("page-1")).toEqual(text(1));
  await cache.put("other", "page-3", text(2));
  expect(await cache.byPage("page-1")).toEqual(text(1));
  expect(await cache.byPage("page-2")).toBeNull();
  expect(await cache.byPage("page-3")).toEqual(text(2));
});

it("preloads only one document's cached pages in a single IndexedDB read", async () => {
  const recognizer = "preload-test";
  const text = (rotation: number) => ({ recognizer, rotation, lines: [] });
  const cache = createIndexedDbPdfOcrCache(recognizer);
  await cache.put("img-1", "doc\n1\n0", text(0));
  await cache.put("img-2", "doc\n2\n90", text(90));
  await cache.put("img-other", "doc2\n1\n0", text(180));

  const loaded = await cache.forDocument!("doc");
  expect([...loaded.entries()]).toEqual([
    ["doc\n1\n0", text(0)],
    ["doc\n2\n90", text(90)],
  ]);
  expect((await cache.forDocument!("missing")).size).toBe(0);
});
