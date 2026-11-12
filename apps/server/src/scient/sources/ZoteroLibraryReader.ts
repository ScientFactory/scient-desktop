import {
  normalizeImportedCitationKey,
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  type ScientSourceCandidate,
  type ZoteroCollection,
  type ZoteroCollectionsResult,
  type ZoteroImportScope,
  type ZoteroLibraryPage,
} from "@scientfactory/scient-sources";

import {
  collectionFromRaw,
  decodeZoteroRawCollections,
  decodeZoteroRawItem,
  decodeZoteroRawItems,
  importableZoteroItems,
  zoteroDescendantCollectionKeys,
  zoteroItemMaterial,
  ZOTERO_ITEM_KEY_PATTERN,
  type ZoteroItemMaterial,
  type ZoteroRawItem,
} from "./ZoteroItems.ts";

const MAX_PAGE_SIZE = 100;
const MAX_ZOTERO_COLLECTIONS = 10_000;
const MAX_ZOTERO_SCOPED_BROWSE_ITEMS = 10_000;
const MAX_IMPORTED_PDFS_PER_ITEM = 10;

export type ZoteroConnectionKind = "local" | "web";

export interface ZoteroResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/** A PDF copied out of Zotero for import; `release` removes any temporary copy. */
export interface ZoteroAttachmentFile {
  readonly path: string;
  readonly fileName: string | null;
  readonly release: () => Promise<void>;
}

/**
 * One way to reach a Zotero library: the local API on this computer, or zotero.org.
 * Paths are relative to the library, such as `/items/top`.
 */
export interface ZoteroTransport {
  readonly connection: ZoteroConnectionKind;
  readonly get: (path: string) => Promise<ZoteroResponse>;
  readonly attachmentFile: (attachment: ZoteroRawItem) => Promise<ZoteroAttachmentFile | null>;
  /** Better BibTeX's keys for items that do not carry one themselves. */
  readonly citationKeys?: (itemKeys: ReadonlyArray<string>) => Promise<ReadonlyMap<string, string>>;
}

function assertZoteroResponse(response: ZoteroResponse): void {
  if (response.status === 403) throw new Error("ZOTERO_ACCESS_DISABLED");
  if (response.status === 501) throw new Error("ZOTERO_INCOMPATIBLE");
  if (response.status === 429 || response.status === 503) {
    throw new Error("Zotero is busy. Try again in a minute.");
  }
  if (response.status === 404) throw new Error("The Zotero item or collection was not found.");
  if (response.status !== 200) throw new Error(`Zotero returned HTTP ${response.status}.`);
}

async function getJson(transport: ZoteroTransport, path: string) {
  const response = await transport.get(path);
  assertZoteroResponse(response);
  return { response, value: JSON.parse(response.body) as unknown };
}

function totalResults(response: ZoteroResponse, fallback: number): number {
  const reported = Number.parseInt(response.headers["total-results"] ?? String(fallback), 10);
  return Number.isFinite(reported) && reported >= 0 ? reported : fallback;
}

async function listAllCollections(
  transport: ZoteroTransport,
): Promise<ReadonlyArray<ZoteroCollection>> {
  const collections: ZoteroCollection[] = [];
  let start = 0;
  while (true) {
    const parameters = new URLSearchParams({
      format: "json",
      limit: String(MAX_PAGE_SIZE),
      start: String(start),
      sort: "title",
      direction: "asc",
    });
    const { response, value } = await getJson(transport, `/collections?${parameters.toString()}`);
    const page = decodeZoteroRawCollections(value).map(collectionFromRaw);
    collections.push(...page);
    if (collections.length > MAX_ZOTERO_COLLECTIONS) {
      throw new Error("Zotero contains too many collections for one import session.");
    }
    start += page.length;
    if (page.length === 0 || start >= totalResults(response, collections.length)) break;
  }
  return collections;
}

export async function listZoteroCollectionsWith(
  transport: ZoteroTransport,
): Promise<ZoteroCollectionsResult> {
  return { collections: [...(await listAllCollections(transport))] };
}

function scopePath(scope: ZoteroImportScope): string {
  if (scope.kind === "library") return "/items/top";
  if (!ZOTERO_ITEM_KEY_PATTERN.test(scope.collectionKey)) {
    throw new Error("The Zotero collection key is invalid.");
  }
  return `/collections/${scope.collectionKey}/items/top`;
}

async function readItemPage(
  transport: ZoteroTransport,
  input: {
    readonly path: string;
    readonly query: string;
    readonly start: number;
    readonly limit: number;
  },
): Promise<{ readonly rawItems: ReadonlyArray<ZoteroRawItem>; readonly total: number }> {
  const parameters = new URLSearchParams({
    format: "json",
    itemType: "-attachment",
    limit: String(input.limit),
    start: String(input.start),
    sort: "dateModified",
    direction: "desc",
  });
  const query = input.query.trim();
  if (query) parameters.set("q", query);
  const { response, value } = await getJson(transport, `${input.path}?${parameters.toString()}`);
  const rawItems = decodeZoteroRawItems(value);
  return { rawItems, total: totalResults(response, rawItems.length) };
}

async function readAllItemsAtPath(
  transport: ZoteroTransport,
  path: string,
  query: string,
  maximumItems: number,
): Promise<ReadonlyArray<ZoteroRawItem>> {
  const items: ZoteroRawItem[] = [];
  let start = 0;
  while (true) {
    const page = await readItemPage(transport, { path, query, start, limit: MAX_PAGE_SIZE });
    items.push(...importableZoteroItems(page.rawItems));
    start += page.rawItems.length;
    if (items.length > maximumItems) {
      throw new Error(
        `This Zotero scope contains more than ${maximumItems} references. Choose a smaller collection or search result.`,
      );
    }
    if (page.rawItems.length === 0 || start >= page.total) break;
  }
  return items;
}

async function readAllScopedItems(
  transport: ZoteroTransport,
  scope: ZoteroImportScope,
  query: string,
  maximumItems: number = MAX_ZOTERO_SCOPED_BROWSE_ITEMS,
): Promise<ReadonlyArray<ZoteroRawItem>> {
  if (scope.kind === "library" || !scope.includeSubcollections) {
    return readAllItemsAtPath(transport, scopePath(scope), query, maximumItems);
  }
  const collections = await listAllCollections(transport);
  if (!collections.some((collection) => collection.key === scope.collectionKey)) {
    throw new Error("The Zotero collection no longer exists.");
  }
  const keys = zoteroDescendantCollectionKeys(scope.collectionKey, collections);
  const unique = new Map<string, ZoteroRawItem>();
  for (let index = 0; index < keys.length; index += 4) {
    const batch = await Promise.all(
      keys
        .slice(index, index + 4)
        .map((key) =>
          readAllItemsAtPath(transport, `/collections/${key}/items/top`, query, maximumItems),
        ),
    );
    for (const items of batch) {
      for (const item of items) unique.set(item.key, item);
    }
    if (unique.size > maximumItems) {
      throw new Error(
        `This Zotero collection contains more than ${maximumItems} references. Choose a smaller collection or search result.`,
      );
    }
  }
  return [...unique.values()].sort((left, right) => {
    const byDate = (right.data.dateModified ?? "").localeCompare(left.data.dateModified ?? "");
    return byDate || left.key.localeCompare(right.key);
  });
}

export async function listZoteroLibraryWith(
  transport: ZoteroTransport,
  input: {
    readonly scope: ZoteroImportScope;
    readonly query: string;
    readonly start: number;
    readonly limit: number;
  },
): Promise<ZoteroLibraryPage> {
  const start = Math.max(0, Math.trunc(input.start));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit)));
  const toCandidate = (item: ZoteroRawItem) => zoteroItemMaterial(item, []).candidate;
  if (input.scope.kind === "collection" && input.scope.includeSubcollections) {
    const allItems = await readAllScopedItems(transport, input.scope, input.query);
    const items = allItems.slice(start, start + limit).map(toCandidate);
    return {
      scope: input.scope,
      items,
      start,
      nextStart: start + items.length,
      total: allItems.length,
      hasMore: start + items.length < allItems.length,
    };
  }
  const page = await readItemPage(transport, {
    path: scopePath(input.scope),
    query: input.query,
    start,
    limit,
  });
  const items = importableZoteroItems(page.rawItems).map(toCandidate);
  return {
    scope: input.scope,
    items,
    start,
    nextStart: start + page.rawItems.length,
    total: page.total,
    hasMore: start + page.rawItems.length < page.total,
  };
}

export async function listZoteroScopeItemKeysWith(
  transport: ZoteroTransport,
  scope: ZoteroImportScope,
): Promise<ReadonlyArray<string>> {
  const items = await readAllScopedItems(transport, scope, "", SCIENT_SOURCE_IMPORT_ITEM_LIMIT);
  return [...new Set(items.map((item) => item.key))];
}

async function readAllChildren(
  transport: ZoteroTransport,
  itemKey: string,
): Promise<ReadonlyArray<ZoteroRawItem>> {
  const children: ZoteroRawItem[] = [];
  let start = 0;
  while (true) {
    const parameters = new URLSearchParams({
      format: "json",
      limit: String(MAX_PAGE_SIZE),
      start: String(start),
    });
    const { response, value } = await getJson(
      transport,
      `/items/${itemKey}/children?${parameters.toString()}`,
    );
    const page = decodeZoteroRawItems(value);
    children.push(...page);
    start += page.length;
    if (page.length === 0 || start >= totalResults(response, children.length)) break;
  }
  return children;
}

async function readZoteroItemWithChildren(
  transport: ZoteroTransport,
  itemKey: string,
): Promise<{ readonly item: ZoteroRawItem; readonly children: ReadonlyArray<ZoteroRawItem> }> {
  if (!ZOTERO_ITEM_KEY_PATTERN.test(itemKey)) throw new Error("The Zotero item key is invalid.");
  const [{ value }, children] = await Promise.all([
    getJson(transport, `/items/${itemKey}?format=json`),
    readAllChildren(transport, itemKey),
  ]);
  return { item: decodeZoteroRawItem(value), children };
}

/** One item with its notes, PDFs and citation key; Better BibTeX fills a key Zotero lacks. */
export async function readZoteroItemMaterial(
  transport: ZoteroTransport,
  itemKey: string,
): Promise<ZoteroItemMaterial> {
  const { item, children } = await readZoteroItemWithChildren(transport, itemKey);
  const material = zoteroItemMaterial(item, children);
  if (material.citationKey || !transport.citationKeys) return material;
  const keys = await transport.citationKeys([item.key]).catch(() => new Map<string, string>());
  const citationKey = normalizeImportedCitationKey(keys.get(item.key));
  return citationKey
    ? { ...material, citationKey, candidate: { ...material.candidate, citationKey } }
    : material;
}

export async function getZoteroItemWith(
  transport: ZoteroTransport,
  itemKey: string,
): Promise<ScientSourceCandidate> {
  return (await readZoteroItemMaterial(transport, itemKey)).candidate;
}

/**
 * Copies an item's PDFs out of Zotero for import. Every returned file must be
 * released, including on failure; a file Zotero cannot provide is skipped.
 */
export async function readZoteroAttachmentFiles(
  transport: ZoteroTransport,
  pdfs: ReadonlyArray<ZoteroRawItem>,
): Promise<ReadonlyArray<ZoteroAttachmentFile & { readonly attachmentKey: string }>> {
  const files: Array<ZoteroAttachmentFile & { readonly attachmentKey: string }> = [];
  try {
    for (const pdf of pdfs.slice(0, MAX_IMPORTED_PDFS_PER_ITEM)) {
      const file = await transport.attachmentFile(pdf);
      if (file) files.push({ ...file, attachmentKey: pdf.key });
    }
    return files;
  } catch (error) {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
    throw error;
  }
}
