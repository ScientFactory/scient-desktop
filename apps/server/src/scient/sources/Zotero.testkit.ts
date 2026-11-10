import type { ZoteroAccess } from "./ZoteroConnections.ts";
import type { ZoteroRawItem } from "./ZoteroItems.ts";
import type { ZoteroResponse, ZoteroTransport } from "./ZoteroLibraryReader.ts";

type ItemData = ZoteroRawItem["data"];

export function zoteroItem(
  key: string,
  data: Omit<Partial<ItemData>, "key"> = {},
  libraryId: string | number = 0,
): ZoteroRawItem {
  const version = data.version ?? 1;
  return {
    key,
    version,
    library: { type: "user", id: libraryId },
    data: { itemType: "journalArticle", ...data, key, version },
  };
}

export interface FakeZoteroLibrary {
  readonly items: Map<string, { item: ZoteroRawItem; children: ReadonlyArray<ZoteroRawItem> }>;
  readonly files?: ReadonlyMap<string, string>;
  readonly failures?: ReadonlyMap<string, Error>;
  readonly citationKeys?: ReadonlyMap<string, string>;
}

const json = (value: unknown, total?: number): ZoteroResponse => ({
  status: 200,
  headers: total === undefined ? {} : { "total-results": String(total) },
  body: JSON.stringify(value),
});

/** Answers the library paths Sources reads, from memory. */
export function fakeZoteroTransport(
  library: FakeZoteroLibrary,
  connection: ZoteroTransport["connection"] = "local",
): ZoteroTransport & { readonly requests: string[] } {
  const requests: string[] = [];
  return {
    connection,
    requests,
    get: async (path) => {
      requests.push(path);
      const [route = ""] = path.split("?");
      const match = /^\/items\/([A-Z0-9]{8})(\/children)?$/u.exec(route);
      if (match?.[1]) {
        const failure = library.failures?.get(match[1]);
        if (failure) throw failure;
        const entry = library.items.get(match[1]);
        if (!entry) return { status: 404, headers: {}, body: "" };
        return match[2] ? json(entry.children, entry.children.length) : json(entry.item);
      }
      if (route === "/items/top") {
        const top = [...library.items.values()].map((entry) => entry.item);
        return json(top, top.length);
      }
      if (route === "/collections") return json([], 0);
      return { status: 404, headers: {}, body: "" };
    },
    attachmentFile: async (attachment) => {
      const path = library.files?.get(attachment.key);
      return path
        ? { path, fileName: attachment.data.filename ?? null, release: async () => undefined }
        : null;
    },
    ...(library.citationKeys
      ? { citationKeys: async () => library.citationKeys ?? new Map<string, string>() }
      : {}),
  };
}

export const fakeZoteroAccess = (local: ZoteroTransport): ZoteroAccess => ({
  webKey: async () => null,
  local,
});
