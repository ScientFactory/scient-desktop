import { msg } from "gt-react";

import { m } from "~/i18n/messages";

import { createIndexedDbConnection } from "../../storage/indexedDbConnection";
import type { PdfOcrPageText } from "./pdfOcrText";

/**
 * Recognized pages, kept in this browser profile. A page is stored under a hash of the
 * image that was read, so identical pages in an edited copy or another file reuse it; a
 * document page (known bytes, page number and rotation) points at its image so reopening a
 * PDF does not render it again.
 */
export interface PdfOcrCache {
  /** Maximum pages retained; sessions also bound their in-memory layers to this limit. */
  readonly maxPages?: number;
  byImage(imageHash: string): Promise<PdfOcrPageText | null>;
  byPage(pageKey: string): Promise<PdfOcrPageText | null>;
  /** All cached readings for one document key in one read, keyed by page key. */
  forDocument?(documentKey: string): Promise<Map<string, PdfOcrPageText>>;
  put(imageHash: string, pageKey: string | null, text: PdfOcrPageText): Promise<void>;
}

const PAGES = "pages";
const ALIASES = "aliases";
const MAX_PAGES = 4_000;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

interface StoredPage {
  readonly text: PdfOcrPageText;
  readonly usedAt: number;
}

interface StoredAlias {
  readonly image: string;
  readonly usedAt: number;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener("success", () => resolve(value.result));
    value.addEventListener("error", () => reject(value.error));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function deleteOldest(store: IDBObjectStore, count: number): Promise<void> {
  let left = count;
  const cursorRequest = store.index("usedAt").openKeyCursor();
  await new Promise<void>((resolve, reject) => {
    cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
    cursorRequest.addEventListener("success", () => {
      const cursor = cursorRequest.result;
      if (!cursor || left <= 0) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      left -= 1;
      cursor.continue();
    });
  });
}

export function createIndexedDbPdfOcrCache(recognizer: string): PdfOcrCache {
  const database = createIndexedDbConnection({
    name: "scient-pdf-ocr",
    version: 1,
    // Read when the connection is blocked, so it is in the language of that moment.
    get blockedMessage() {
      return m(msg("Recognized text storage is blocked."));
    },
    upgrade: (db) => {
      for (const name of [PAGES, ALIASES]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name).createIndex("usedAt", "usedAt");
        }
      }
    },
  });
  const key = (value: string) => `${recognizer}\n${value}`;
  const recognizerPrefix = `${recognizer}\n`;
  const read = (imageKey: string) =>
    database.transaction(PAGES, "readonly", (transaction) =>
      request(transaction.objectStore(PAGES).get(imageKey) as IDBRequest<StoredPage | undefined>),
    );
  const touchKeys = (imageKeys: ReadonlyArray<string>, aliasKeys: ReadonlyArray<string>) => {
    if (imageKeys.length === 0 && aliasKeys.length === 0) return;
    const now = Date.now();
    const stores =
      imageKeys.length > 0 && aliasKeys.length > 0
        ? [PAGES, ALIASES]
        : imageKeys.length > 0
          ? PAGES
          : ALIASES;
    void database
      .transaction(stores, "readwrite", async (transaction) => {
        if (imageKeys.length > 0) {
          const store = transaction.objectStore(PAGES);
          for (const imageKey of imageKeys) {
            // Re-read inside the write transaction so a newer put is never overwritten.
            const current = await request(
              store.get(imageKey) as IDBRequest<StoredPage | undefined>,
            );
            if (current && now - current.usedAt > TOUCH_AFTER_MS) {
              store.put({ ...current, usedAt: now }, imageKey);
            }
          }
        }
        if (aliasKeys.length > 0) {
          const store = transaction.objectStore(ALIASES);
          for (const aliasKey of aliasKeys) {
            const current = await request(
              store.get(aliasKey) as IDBRequest<StoredAlias | undefined>,
            );
            if (current && now - current.usedAt > TOUCH_AFTER_MS) {
              store.put({ ...current, usedAt: now }, aliasKey);
            }
          }
        }
        return done(transaction);
      })
      .catch(() => undefined);
  };
  return {
    maxPages: MAX_PAGES,
    async byImage(imageHash) {
      const imageKey = key(imageHash);
      const stored = await read(imageKey).catch(() => undefined);
      if (stored?.text.recognizer !== recognizer) return null;
      // Recency only orders eviction; a day's precision spares a write per page read.
      if (Date.now() - stored.usedAt > TOUCH_AFTER_MS) touchKeys([imageKey], []);
      return stored.text;
    },
    async byPage(pageKey) {
      try {
        const aliasKey = key(pageKey);
        const hit = await database.transaction(
          [ALIASES, PAGES],
          "readonly",
          async (transaction) => {
            const alias = await request(
              transaction.objectStore(ALIASES).get(aliasKey) as IDBRequest<StoredAlias | undefined>,
            );
            if (!alias) return null;
            const imageKey = key(alias.image);
            const stored = await request(
              transaction.objectStore(PAGES).get(imageKey) as IDBRequest<StoredPage | undefined>,
            );
            return stored ? { alias, imageKey, stored } : null;
          },
        );
        if (!hit || hit.stored.text.recognizer !== recognizer) return null;
        const now = Date.now();
        touchKeys(
          now - hit.stored.usedAt > TOUCH_AFTER_MS ? [hit.imageKey] : [],
          now - hit.alias.usedAt > TOUCH_AFTER_MS ? [aliasKey] : [],
        );
        return hit.stored.text;
      } catch {
        return null;
      }
    },
    async forDocument(documentKey) {
      const found = new Map<string, PdfOcrPageText>();
      const stalePages: string[] = [];
      const staleAliases: string[] = [];
      try {
        const prefix = `${key(documentKey)}\n`;
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        const now = Date.now();
        await database.transaction([ALIASES, PAGES], "readonly", async (transaction) => {
          const aliasStore = transaction.objectStore(ALIASES);
          const [aliasKeys, aliases] = await Promise.all([
            request(aliasStore.getAllKeys(range) as IDBRequest<string[]>),
            request(aliasStore.getAll(range) as IDBRequest<StoredAlias[]>),
          ]);
          if (aliasKeys.length === 0) return;
          const pageStore = transaction.objectStore(PAGES);
          const pages = await Promise.all(
            aliases.map((alias) =>
              request(pageStore.get(key(alias.image)) as IDBRequest<StoredPage | undefined>),
            ),
          );
          for (let index = 0; index < aliasKeys.length; index += 1) {
            const stored = pages[index];
            const alias = aliases[index]!;
            if (stored?.text.recognizer !== recognizer) continue;
            const aliasKey = aliasKeys[index]!;
            found.set(aliasKey.slice(recognizerPrefix.length), stored.text);
            if (now - stored.usedAt > TOUCH_AFTER_MS) stalePages.push(key(alias.image));
            if (now - alias.usedAt > TOUCH_AFTER_MS) staleAliases.push(aliasKey);
          }
        });
        touchKeys(stalePages, staleAliases);
      } catch {
        // Unavailable storage only costs a later recognition.
      }
      return found;
    },
    async put(imageHash, pageKey, text) {
      try {
        await database.transaction([PAGES, ALIASES], "readwrite", async (transaction) => {
          const usedAt = Date.now();
          transaction.objectStore(PAGES).put({ text, usedAt } satisfies StoredPage, key(imageHash));
          if (pageKey !== null) {
            transaction
              .objectStore(ALIASES)
              .put({ image: imageHash, usedAt } satisfies StoredAlias, key(pageKey));
          }
          // Enforce the shared limit in this write, including after an app restart.
          for (const name of [PAGES, ALIASES]) {
            const store = transaction.objectStore(name);
            const count = await request(store.count());
            if (count > MAX_PAGES) await deleteOldest(store, count - MAX_PAGES);
          }
          return done(transaction);
        });
      } catch {
        // Unavailable storage only costs a later recognition.
      }
    },
  };
}

/**
 * For password-unlocked PDFs, browsers without IndexedDB, and tests. Bounded like the
 * profile cache: the least recently used reading goes first, with the pages pointing at it.
 */
export function createMemoryPdfOcrCache(maxPages = MAX_PAGES): PdfOcrCache {
  // Map order is use order: a read or write moves an entry to the end.
  const pages = new Map<string, PdfOcrPageText>();
  const aliases = new Map<string, string>();
  const use = (imageHash: string): PdfOcrPageText | null => {
    const text = pages.get(imageHash);
    if (text === undefined) return null;
    pages.delete(imageHash);
    pages.set(imageHash, text);
    return text;
  };
  const useAlias = (pageKey: string): PdfOcrPageText | null => {
    const image = aliases.get(pageKey);
    if (image === undefined) return null;
    aliases.delete(pageKey);
    aliases.set(pageKey, image);
    return use(image);
  };
  return {
    maxPages,
    byImage: async (imageHash) => use(imageHash),
    byPage: async (pageKey) => useAlias(pageKey),
    forDocument: async (documentKey) => {
      const prefix = `${documentKey}\n`;
      const found = new Map<string, PdfOcrPageText>();
      for (const aliasKey of Array.from(aliases.keys())) {
        if (!aliasKey.startsWith(prefix)) continue;
        const text = useAlias(aliasKey);
        if (text) found.set(aliasKey, text);
      }
      return found;
    },
    put: async (imageHash, pageKey, text) => {
      pages.delete(imageHash);
      pages.set(imageHash, text);
      if (pageKey !== null) {
        aliases.delete(pageKey);
        aliases.set(pageKey, imageHash);
      }
      for (const oldest of pages.keys()) {
        if (pages.size <= maxPages) break;
        pages.delete(oldest);
        for (const [key, image] of aliases) if (image === oldest) aliases.delete(key);
      }
      for (const oldest of aliases.keys()) {
        if (aliases.size <= maxPages) break;
        aliases.delete(oldest);
      }
    },
  };
}
