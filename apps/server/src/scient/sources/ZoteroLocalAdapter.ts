// @effect-diagnostics nodeBuiltinImport:off -- This is the fixed-loopback Zotero transport boundary.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import {
  normalizeScientSourceAbstractDocument,
  SCIENT_SOURCE_IMPORT_ITEM_LIMIT,
  scientSourceTypeFromZotero,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ZoteroCollection,
  type ZoteroCollectionsResult,
  type ZoteroConnectionStatus,
  type ZoteroImportScope,
  type ZoteroLibraryPage,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

import { enrichScientSourceCandidate } from "./SourceMetadataEnricher.ts";

const ZOTERO_HOST = "127.0.0.1";
const ZOTERO_PORT = 23_119;
const ZOTERO_API_VERSION = 3;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_ZOTERO_COLLECTIONS = 10_000;
const MAX_ZOTERO_SCOPED_BROWSE_ITEMS = 10_000;
const ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u;

const ZoteroRawCreator = Schema.Struct({
  creatorType: Schema.optionalKey(Schema.String),
  firstName: Schema.optionalKey(Schema.String),
  lastName: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const ZoteroRawItemData = Schema.Struct({
  key: Schema.String,
  version: Schema.Int,
  itemType: Schema.String,
  title: Schema.optionalKey(Schema.String),
  creators: Schema.optionalKey(Schema.Array(ZoteroRawCreator)),
  date: Schema.optionalKey(Schema.String),
  DOI: Schema.optionalKey(Schema.String),
  ISBN: Schema.optionalKey(Schema.String),
  ISSN: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(Schema.String),
  abstractNote: Schema.optionalKey(Schema.String),
  publicationTitle: Schema.optionalKey(Schema.String),
  bookTitle: Schema.optionalKey(Schema.String),
  proceedingsTitle: Schema.optionalKey(Schema.String),
  publisher: Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  pages: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.Struct({ tag: Schema.String }))),
  contentType: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
  linkMode: Schema.optionalKey(Schema.String),
  dateModified: Schema.optionalKey(Schema.String),
});

const ZoteroRawItem = Schema.Struct({
  key: Schema.String,
  version: Schema.Int,
  library: Schema.Struct({
    type: Schema.String,
    id: Schema.Union([Schema.String, Schema.Number]),
  }),
  data: ZoteroRawItemData,
});

const ZoteroRawItems = Schema.Array(ZoteroRawItem);
const decodeZoteroRawItem = Schema.decodeUnknownSync(ZoteroRawItem);
const decodeZoteroRawItems = Schema.decodeUnknownSync(ZoteroRawItems);
type ZoteroRawItem = typeof ZoteroRawItem.Type;

const ZoteroRawCollection = Schema.Struct({
  key: Schema.String,
  data: Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    parentCollection: Schema.optionalKey(Schema.Union([Schema.String, Schema.Boolean])),
  }),
});
const ZoteroRawCollections = Schema.Array(ZoteroRawCollection);
const decodeZoteroRawCollections = Schema.decodeUnknownSync(ZoteroRawCollections);
type ZoteroRawCollection = typeof ZoteroRawCollection.Type;

interface LocalResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

function localRequest(path: string): Promise<LocalResponse> {
  if (!path.startsWith("/api/")) throw new Error("Zotero path must remain under the local API.");
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: ZOTERO_HOST,
        port: ZOTERO_PORT,
        method: "GET",
        path,
        headers: {
          Accept: "application/json",
          "Zotero-API-Version": String(ZOTERO_API_VERSION),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Zotero returned more data than Scient can safely accept."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Timed out while contacting Zotero."));
    });
    request.on("error", reject);
    request.end();
  });
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function creator(raw: typeof ZoteroRawCreator.Type): ScientSourceCreator | null {
  const givenName = text(raw.firstName);
  const familyName = text(raw.lastName);
  const literalName = text(raw.name);
  if (!givenName && !familyName && !literalName) return null;
  return {
    creatorType: text(raw.creatorType) ?? "author",
    givenName,
    familyName,
    literalName,
  };
}

function publicationYear(date: string | undefined): number | null {
  const match = date?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function identifiers(data: ZoteroRawItem["data"]): ReadonlyArray<ScientSourceIdentifier> {
  return [
    ["doi", data.DOI],
    ["isbn", data.ISBN],
    ["issn", data.ISSN],
    ["pmid", data.PMID],
  ].flatMap(([scheme, value]) => {
    const normalized = text(value);
    return normalized && scheme ? [{ scheme, value: normalized }] : [];
  });
}

function provenance(data: ZoteroRawItem["data"]): ReadonlyArray<ScientSourceFieldProvenance> {
  const containerField = data.publicationTitle
    ? "publicationTitle"
    : data.bookTitle
      ? "bookTitle"
      : data.proceedingsTitle
        ? "proceedingsTitle"
        : null;
  const fields: ReadonlyArray<readonly [string, string, boolean]> = [
    ["title", "title", text(data.title) !== null],
    ["creators", "creators", (data.creators ?? []).length > 0],
    ["issuedRaw", "date", text(data.date) !== null],
    ["abstract", "abstractNote", text(data.abstractNote) !== null],
    ["publisher", "publisher", text(data.publisher) !== null],
    ["volume", "volume", text(data.volume) !== null],
    ["issue", "issue", text(data.issue) !== null],
    ["pages", "pages", text(data.pages) !== null],
    ["language", "language", text(data.language) !== null],
    ["url", "url", text(data.url) !== null],
    ["tags", "tags", (data.tags ?? []).some((tag) => tag.tag.trim().length > 0)],
    ["identifiers.doi", "DOI", text(data.DOI) !== null],
    ["identifiers.isbn", "ISBN", text(data.ISBN) !== null],
    ["identifiers.issn", "ISSN", text(data.ISSN) !== null],
    ["identifiers.pmid", "PMID", text(data.PMID) !== null],
  ];
  const result = fields
    .filter(([, , present]) => present)
    .map(([field, sourceField]) => ({ field, origin: "zotero" as const, sourceField }));
  if (containerField) {
    result.push({ field: "containerTitle", origin: "zotero", sourceField: containerField });
  }
  return result;
}

export function zoteroItemToCandidate(raw: ZoteroRawItem): ScientSourceCandidate {
  const data = raw.data;
  const type = scientSourceTypeFromZotero(data.itemType);
  const abstract = normalizeScientSourceAbstractDocument(data.abstractNote);
  return {
    sourceKey: raw.key,
    type,
    // Preserve Zotero's exact genre when it is outside Scient's deliberately
    // small canonical type set. Otherwise editing an imported record would
    // present an unexplained, invalid "Other source" with its type discarded.
    customType: type === "other" ? text(data.itemType) : null,
    title: text(data.title),
    creators: (data.creators ?? []).flatMap((value) => {
      const normalized = creator(value);
      return normalized ? [normalized] : [];
    }),
    issuedRaw: text(data.date),
    issuedYear: publicationYear(data.date),
    identifiers: identifiers(data),
    abstract: abstract?.text ?? null,
    ...(abstract ? { abstractSections: [...abstract.sections] } : {}),
    containerTitle: text(data.publicationTitle ?? data.bookTitle ?? data.proceedingsTitle),
    publisher: text(data.publisher),
    volume: text(data.volume),
    issue: text(data.issue),
    pages: text(data.pages),
    language: text(data.language),
    url: text(data.url),
    tags: (data.tags ?? []).map((tag) => tag.tag.trim()).filter(Boolean),
    externalReferences: [
      {
        system: "zotero",
        libraryId: String(raw.library.id),
        itemKey: raw.key,
        itemVersion: raw.version,
        rawItemType: data.itemType,
      },
    ],
    fieldProvenance: provenance(data),
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

function decodeItems(body: string): ReadonlyArray<ZoteroRawItem> {
  const value: unknown = JSON.parse(body);
  return decodeZoteroRawItems(value);
}

function decodeCollections(body: string): ReadonlyArray<ZoteroRawCollection> {
  const value: unknown = JSON.parse(body);
  return decodeZoteroRawCollections(value);
}

function assertReady(response: LocalResponse): void {
  if (response.status === 403) throw new Error("ZOTERO_ACCESS_DISABLED");
  if (response.status === 501) throw new Error("ZOTERO_INCOMPATIBLE");
  if (response.status !== 200) throw new Error(`Zotero returned HTTP ${response.status}.`);
  const version = Number.parseInt(response.headers["zotero-api-version"] ?? "", 10);
  if (version !== ZOTERO_API_VERSION) throw new Error("ZOTERO_INCOMPATIBLE");
}

export async function inspectZoteroConnection(): Promise<ZoteroConnectionStatus> {
  let response: LocalResponse;
  try {
    response = await localRequest("/api/");
  } catch {
    return {
      state: "unreachable",
      apiVersion: null,
      message: "Open Zotero on the computer running this project, then check again.",
    };
  }
  const version = Number.parseInt(response.headers["zotero-api-version"] ?? "", 10);
  if (response.status === 403) {
    return {
      state: "access-disabled",
      apiVersion: Number.isFinite(version) ? version : null,
      message:
        "In Zotero, open Settings → Advanced and enable “Allow other applications on this computer to communicate with Zotero.”",
    };
  }
  if (response.status === 501 || (Number.isFinite(version) && version !== ZOTERO_API_VERSION)) {
    return {
      state: "incompatible",
      apiVersion: Number.isFinite(version) ? version : null,
      message: "This Zotero local API version is not compatible with Scient.",
    };
  }
  if (response.status !== 200 || !Number.isFinite(version)) {
    return {
      state: "malformed",
      apiVersion: null,
      message: "Zotero responded, but Scient could not validate the local API.",
    };
  }
  return { state: "ready", apiVersion: version, message: "Zotero is ready for local import." };
}

function collectionFromRaw(raw: ZoteroRawCollection): ZoteroCollection {
  const parent = raw.data.parentCollection;
  return {
    key: raw.data.key || raw.key,
    name: raw.data.name.trim() || "Untitled collection",
    parentCollectionKey: typeof parent === "string" && parent.trim() ? parent : null,
  };
}

async function listAllZoteroCollections(): Promise<ReadonlyArray<ZoteroCollection>> {
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
    const response = await localRequest(`/api/users/0/collections?${parameters.toString()}`);
    assertReady(response);
    const page = decodeCollections(response.body).map(collectionFromRaw);
    collections.push(...page);
    if (collections.length > MAX_ZOTERO_COLLECTIONS) {
      throw new Error("Zotero contains too many collections for one import session.");
    }
    const reportedTotal = Number.parseInt(
      response.headers["total-results"] ?? String(collections.length),
      10,
    );
    const total = Number.isFinite(reportedTotal) ? reportedTotal : collections.length;
    start += page.length;
    if (page.length === 0 || start >= total) break;
  }
  return collections;
}

export async function listZoteroCollections(): Promise<ZoteroCollectionsResult> {
  return { collections: [...(await listAllZoteroCollections())] };
}

function scopePath(scope: ZoteroImportScope): string {
  if (scope.kind === "library") return "/api/users/0/items/top";
  if (!ITEM_KEY_PATTERN.test(scope.collectionKey)) {
    throw new Error("The Zotero collection key is invalid.");
  }
  return `/api/users/0/collections/${scope.collectionKey}/items/top`;
}

function importableItems(items: ReadonlyArray<ZoteroRawItem>): ReadonlyArray<ZoteroRawItem> {
  return items.filter(
    (item) => item.data.itemType !== "note" && item.data.itemType !== "annotation",
  );
}

async function readZoteroItemPage(input: {
  readonly path: string;
  readonly query: string;
  readonly start: number;
  readonly limit: number;
}): Promise<{ readonly rawItems: ReadonlyArray<ZoteroRawItem>; readonly total: number }> {
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
  const response = await localRequest(`${input.path}?${parameters.toString()}`);
  assertReady(response);
  const rawItems = decodeItems(response.body);
  const reportedTotal = Number.parseInt(
    response.headers["total-results"] ?? String(rawItems.length),
    10,
  );
  return {
    rawItems,
    total: Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : rawItems.length,
  };
}

export function zoteroDescendantCollectionKeys(
  collectionKey: string,
  collections: ReadonlyArray<ZoteroCollection>,
): ReadonlyArray<string> {
  const result = new Set<string>([collectionKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const collection of collections) {
      if (
        collection.parentCollectionKey &&
        result.has(collection.parentCollectionKey) &&
        !result.has(collection.key)
      ) {
        result.add(collection.key);
        changed = true;
      }
    }
  }
  return [...result];
}

async function readAllItemsAtPath(
  path: string,
  query: string,
  maximumItems: number,
): Promise<ReadonlyArray<ZoteroRawItem>> {
  const items: ZoteroRawItem[] = [];
  let start = 0;
  while (true) {
    const page = await readZoteroItemPage({ path, query, start, limit: MAX_PAGE_SIZE });
    items.push(...importableItems(page.rawItems));
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
  scope: ZoteroImportScope,
  query: string,
  maximumItems: number = MAX_ZOTERO_SCOPED_BROWSE_ITEMS,
): Promise<ReadonlyArray<ZoteroRawItem>> {
  if (scope.kind === "library" || !scope.includeSubcollections) {
    return readAllItemsAtPath(scopePath(scope), query, maximumItems);
  }
  const collections = await listAllZoteroCollections();
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
          readAllItemsAtPath(`/api/users/0/collections/${key}/items/top`, query, maximumItems),
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

export async function listZoteroLibrary(input: {
  readonly scope: ZoteroImportScope;
  readonly query: string;
  readonly start: number;
  readonly limit: number;
}): Promise<ZoteroLibraryPage> {
  const start = Math.max(0, Math.trunc(input.start));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit)));
  if (input.scope.kind === "collection" && input.scope.includeSubcollections) {
    const allItems = await readAllScopedItems(input.scope, input.query);
    const items = allItems.slice(start, start + limit).map(zoteroItemToCandidate);
    return {
      scope: input.scope,
      items,
      start,
      nextStart: start + items.length,
      total: allItems.length,
      hasMore: start + items.length < allItems.length,
    };
  }
  const page = await readZoteroItemPage({
    path: scopePath(input.scope),
    query: input.query,
    start,
    limit,
  });
  const items = importableItems(page.rawItems).map(zoteroItemToCandidate);
  return {
    scope: input.scope,
    items,
    start,
    nextStart: start + page.rawItems.length,
    total: page.total,
    hasMore: start + page.rawItems.length < page.total,
  };
}

export async function listZoteroScopeItemKeys(
  scope: ZoteroImportScope,
): Promise<ReadonlyArray<string>> {
  return [
    ...new Set(
      (await readAllScopedItems(scope, "", SCIENT_SOURCE_IMPORT_ITEM_LIMIT)).map(
        (item) => item.key,
      ),
    ),
  ];
}

async function readZoteroItemWithChildren(itemKey: string): Promise<{
  readonly item: ZoteroRawItem;
  readonly children: ReadonlyArray<ZoteroRawItem>;
}> {
  if (!ITEM_KEY_PATTERN.test(itemKey)) throw new Error("The Zotero item key is invalid.");
  const [itemResponse, childrenResponse] = await Promise.all([
    localRequest(`/api/users/0/items/${itemKey}?format=json`),
    localRequest(`/api/users/0/items/${itemKey}/children?format=json`),
  ]);
  assertReady(itemResponse);
  assertReady(childrenResponse);
  const value: unknown = JSON.parse(itemResponse.body);
  const item = decodeZoteroRawItem(value);
  const children = decodeItems(childrenResponse.body);
  return { item, children };
}

function comparePdfAttachments(left: ZoteroRawItem, right: ZoteroRawItem): number {
  const leftName = text(left.data.filename) ?? "";
  const rightName = text(right.data.filename) ?? "";
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function pdfAttachments(children: ReadonlyArray<ZoteroRawItem>): ReadonlyArray<ZoteroRawItem> {
  return children
    .filter(
      (child) =>
        child.data.itemType === "attachment" &&
        child.data.contentType?.toLowerCase() === "application/pdf",
    )
    .toSorted(comparePdfAttachments);
}

export function zoteroItemWithChildrenToCandidate(
  item: ZoteroRawItem,
  children: ReadonlyArray<ZoteroRawItem>,
): ScientSourceCandidate {
  const pdfs = pdfAttachments(children);
  return zoteroItemWithPdfsToCandidate(item, pdfs);
}

function zoteroItemWithPdfsToCandidate(
  item: ZoteroRawItem,
  pdfs: ReadonlyArray<ZoteroRawItem>,
): ScientSourceCandidate {
  const primaryPdf = pdfs[0];
  return {
    ...zoteroItemToCandidate(item),
    pdfAvailable: primaryPdf !== undefined,
    pdfFileName: primaryPdf ? text(primaryPdf.data.filename) : null,
    pdfAttachmentCount: pdfs.length,
  };
}

export async function getZoteroItem(itemKey: string): Promise<ScientSourceCandidate> {
  const { item, children } = await readZoteroItemWithChildren(itemKey);
  return zoteroItemWithChildrenToCandidate(item, children);
}

export async function getZoteroImportMaterial(itemKey: string): Promise<{
  readonly candidate: ScientSourceCandidate;
  readonly pdfPath: string | null;
}> {
  const { item, children } = await readZoteroItemWithChildren(itemKey);
  const pdfs = pdfAttachments(children);
  const pdf = pdfs[0];
  const candidate = await enrichScientSourceCandidate(zoteroItemWithPdfsToCandidate(item, pdfs));
  if (!pdf) return { candidate, pdfPath: null };
  const response = await localRequest(`/api/users/0/items/${pdf.key}/file/view/url`);
  assertReady(response);
  const url = new URL(response.body.trim());
  if (url.protocol !== "file:") throw new Error("Zotero returned a non-local attachment URL.");
  return { candidate, pdfPath: NodeURL.fileURLToPath(url) };
}
